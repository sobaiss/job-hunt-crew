import re
from dataclasses import dataclass, replace
from enum import Enum
from io import BytesIO

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from fpdf import FPDF
from fpdf.enums import XPos, YPos
from py_db.section_type import SectionType

_MARGIN_MM = 20
_BODY_FONT_SIZE = 11
_HEADING_FONT_SIZE = 14

# #100: when a StyleProfile's `onePageFit` is set, PDF rendering tries these
# (margin_mm, font_scale) levels in order — from the normal template down to
# a bounded, still-readable floor — and stops at the first level that keeps
# the render to one page. If even the floor doesn't fit, the floor render is
# used as-is and the content is allowed to spill onto a second page.
_MARGIN_FLOOR_MM = 12
_FONT_SCALE_FLOOR = 0.85
_PDF_ONE_PAGE_FIT_LEVELS = [(_MARGIN_MM, 1.0), (16, 0.94), (_MARGIN_FLOOR_MM, _FONT_SCALE_FLOOR)]

# DOCX has no page-layout engine (same limitation noted in
# style_profile.py's DOCX_ONE_PAGE_CHAR_BUDGET), so "does this spill past one
# page" is approximated by the same character-count proxy rather than a real
# page count. Crossing the budget triggers the one bounded reduction step
# below (margins down to a fixed floor, explicit font sizes at
# _FONT_SCALE_FLOOR) — there's no finer-grained ladder to walk since there's
# no measurement to walk it against.
_DOCX_ONE_PAGE_CHAR_BUDGET = 3500
_DOCX_MARGIN_FLOOR_PT = 36
_DOCX_HEADING1_FONT_SIZE = 14
_DOCX_HEADING2_FONT_SIZE = 12

# #99: neither fpdf nor python-docx has a real multi-column text-flow
# primitive, so a SIDEBAR_MAIN StyleProfile is rendered as two independently
# positioned/sized regions instead — a fixed-width sidebar and a wider main
# region that just reflows to however much content it's given.
_SIDEBAR_WIDTH_MM = 55
_COLUMN_GAP_MM = 8
_DOCX_SIDEBAR_WIDTH = Inches(2.0)
_DOCX_MAIN_WIDTH = Inches(4.5)

# CvTailoringAgent (#97) tags every heading it writes with this HTML comment,
# on its own line right below the heading. It must never reach a
# candidate-facing rendition, so every renderer strips it here.
_SECTION_TYPE_COMMENT_RE = re.compile(r"<!--\s*SectionType:\s*(\w+)\s*-->")

# fpdf ships only the base-14 PDF fonts (no arbitrary TTF embedding without
# shipping font files, which this renderer doesn't), so a StyleProfile font
# family is mapped to the closest built-in rather than used by name.
_FONT_FAMILY_TO_PDF_FONT = {"serif": "Times", "sans-serif": "Helvetica", "monospace": "Courier"}

# Word can render an arbitrary font by name (falling back at open-time if the
# reader doesn't have it installed), but that fallback is an unpredictable
# substitute picked by whichever reader opens the file. So a real extracted
# name is only used directly when it's in this small curated set known to be
# available cross-platform; any other name (however common on the machine it
# was extracted from) is replaced by its family's entry here instead (#100).
_FONT_FAMILY_TO_DOCX_FONT = {"serif": "Times New Roman", "sans-serif": "Arial", "monospace": "Courier New"}
_CURATED_DOCX_FONTS = {"Arial", "Times New Roman", "Courier New", "Georgia", "Calibri", "Verdana"}


def _docx_font_name(font_descriptor: dict | None) -> str | None:
    if not font_descriptor:
        return None
    name = font_descriptor.get("name")
    if name and name in _CURATED_DOCX_FONTS:
        return name
    return _FONT_FAMILY_TO_DOCX_FONT.get(font_descriptor.get("family"))


class _LineKind(Enum):
    BLANK = "blank"
    HEADING1 = "heading1"
    HEADING2 = "heading2"
    HEADING3 = "heading3"
    BULLET = "bullet"
    RULE = "rule"
    PARAGRAPH = "paragraph"


@dataclass(frozen=True)
class _Line:
    kind: _LineKind
    text: str
    section_type: SectionType | None = None


def _parse_section_type(raw: str) -> SectionType | None:
    try:
        return SectionType(raw)
    except ValueError:
        return None


def _classify_lines(markdown_content: str) -> list[_Line]:
    """Splits a GeneratedDocument's Markdown into classified lines, shared by
    every renderer below. Deliberately not a full Markdown parser — the
    generation agents only ever produce this small target set (`#`/`##`/`###`
    headings, `-`/`*` bullets, a `---` rule, blank lines, plain paragraphs —
    see cover_letter_writer_agent.py / cv_tailoring_agent.py and docs/adr/0009).
    A `<!-- SectionType: X -->` comment right below a heading (#97) is
    stripped and attached to that heading instead of being emitted as its
    own line — only for `#`/`##` (#106: CvTailoringAgent only tags top-level
    section headings, so a `###` heading never receives StyleProfile
    treatment via this mechanism).
    """
    lines: list[_Line] = []
    for raw_line in markdown_content.splitlines():
        line = raw_line.strip()
        if not line:
            lines.append(_Line(_LineKind.BLANK, ""))
            continue
        comment_match = _SECTION_TYPE_COMMENT_RE.fullmatch(line)
        if comment_match:
            if lines and lines[-1].kind in (_LineKind.HEADING1, _LineKind.HEADING2):
                lines[-1] = replace(lines[-1], section_type=_parse_section_type(comment_match.group(1)))
            continue
        if line.startswith("### "):
            lines.append(_Line(_LineKind.HEADING3, line.removeprefix("### ")))
        elif line.startswith("## "):
            lines.append(_Line(_LineKind.HEADING2, line.removeprefix("## ")))
        elif line.startswith("# "):
            lines.append(_Line(_LineKind.HEADING1, line.removeprefix("# ")))
        elif line == "---":
            lines.append(_Line(_LineKind.RULE, ""))
        elif line.startswith(("- ", "* ")):
            lines.append(_Line(_LineKind.BULLET, line[2:]))
        else:
            lines.append(_Line(_LineKind.PARAGRAPH, line))
    return lines


def _latin1_safe(text: str) -> str:
    """The built-in Helvetica font only supports latin-1. LLM-generated
    Markdown routinely contains smart quotes/em-dashes outside that range,
    so unsupported characters are replaced rather than raising.
    """
    return text.encode("latin-1", errors="replace").decode("latin-1")


def _block(pdf: FPDF, line_height: float, text: str, *, width: float = 0) -> None:
    """multi_cell defaults to leaving the cursor at the right margin
    (new_x=XPos.RIGHT), which starves the next call of width. `new_x=LEFT`
    returns the cursor to wherever this cell started (the page margin for a
    full-width block, or a column's own x for a sidebar/main block — #99),
    so the next line in the same column keeps its width.
    """
    pdf.multi_cell(width, line_height, text, new_x=XPos.LEFT, new_y=YPos.NEXT)


_STYLED_ARCHETYPES = ("SINGLE_COLUMN", "SIDEBAR_MAIN")


def _active_style_profile(style_profile: dict | None) -> dict | None:
    """A StyleProfile only styles rendering for the SINGLE_COLUMN (#98) and
    SIDEBAR_MAIN (#99) archetypes; anything else (or no profile at all)
    falls back to the generic template."""
    if style_profile is None or style_profile.get("layoutArchetype") not in _STYLED_ARCHETYPES:
        return None
    return style_profile


def _section_region(profile: dict, section_type: SectionType | None) -> str:
    """The StyleProfile's SIDEBAR/MAIN assignment for a heading's
    SectionType (#99). A heading with no recognized SectionType, or one the
    classification didn't assign a region, defaults to MAIN — the sidebar is
    only ever the StyleProfile's explicit, short/low-variance picks."""
    if section_type is None:
        return "MAIN"
    return profile.get("sections", {}).get(section_type.value, {}).get("region") or "MAIN"


def _group_lines_by_region(lines: list[_Line], profile: dict) -> tuple[list[_Line], list[_Line]]:
    """Splits classified lines into (sidebar_lines, main_lines) for a
    SIDEBAR_MAIN StyleProfile (#99). Every line inherits the region of the
    most recent heading above it — content above any heading defaults to
    MAIN. Order within each region is preserved exactly as it appears in the
    source Markdown (#98's rule: section order always follows the tailored
    Markdown, never the StyleProfile)."""
    sidebar: list[_Line] = []
    main: list[_Line] = []
    current_region = "MAIN"
    for line in lines:
        if line.kind in (_LineKind.HEADING1, _LineKind.HEADING2):
            current_region = _section_region(profile, line.section_type)
        (sidebar if current_region == "SIDEBAR" else main).append(line)
    return sidebar, main


def _hex_to_rgb(hex_color: str | None) -> tuple[int, int, int] | None:
    if not hex_color:
        return None
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return None
    return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))


def _heading_treatment(style_profile: dict, section_type: SectionType | None) -> dict | None:
    if section_type is None:
        return None
    return style_profile.get("sections", {}).get(section_type.value, {}).get("headingTreatment")


def _render_pdf_lines(
    pdf: FPDF,
    lines: list[_Line],
    profile: dict | None,
    *,
    body_font: str,
    body_color: tuple[int, int, int],
    font_scale: float,
    width: float,
    x: float | None = None,
) -> None:
    """Renders classified lines from the PDF's current cursor, applying a
    profile's per-SectionType heading treatment. Used both for a single
    full-width column (#98, `x=None`, `width=0`) and for a SIDEBAR_MAIN
    profile's narrow/wide columns (#99): when `x` is given, the cursor
    returns to it before every line so two independently-flowing columns
    can be rendered without fighting over fpdf's single shared cursor.
    """
    for line in lines:
        if x is not None:
            pdf.set_x(x)
        if line.kind is _LineKind.BLANK:
            pdf.ln(3 * font_scale)
        elif line.kind in (_LineKind.HEADING1, _LineKind.HEADING2):
            base_size = _HEADING_FONT_SIZE if line.kind is _LineKind.HEADING1 else _BODY_FONT_SIZE + 1
            treatment = profile and _heading_treatment(profile, line.section_type)
            font = _FONT_FAMILY_TO_PDF_FONT.get(
                (treatment or {}).get("font", {}).get("family"), body_font
            )
            color = _hex_to_rgb((treatment or {}).get("color")) or body_color
            pdf.set_text_color(*color)
            pdf.set_font(font, style="B", size=round(base_size * font_scale))
            line_height = (8 if line.kind is _LineKind.HEADING1 else 7) * font_scale
            _block(pdf, line_height, _latin1_safe(line.text), width=width)
            pdf.set_text_color(0, 0, 0)
        elif line.kind is _LineKind.HEADING3:
            # #106: a `###` heading never picks up a profile's per-SectionType
            # treatment — CvTailoringAgent only tags top-level headings, so
            # this always renders in the template's plain default style.
            pdf.set_text_color(*body_color)
            pdf.set_font(body_font, style="B", size=round(_BODY_FONT_SIZE * font_scale))
            _block(pdf, 6 * font_scale, _latin1_safe(line.text), width=width)
            pdf.set_text_color(0, 0, 0)
        elif line.kind is _LineKind.RULE:
            rule_width = width if width else pdf.w - pdf.l_margin - pdf.r_margin
            rule_y = pdf.get_y() + font_scale
            pdf.line(pdf.get_x(), rule_y, pdf.get_x() + rule_width, rule_y)
            pdf.ln(4 * font_scale)
        elif line.kind is _LineKind.BULLET:
            pdf.set_text_color(*body_color)
            pdf.set_font(body_font, size=round(_BODY_FONT_SIZE * font_scale))
            _block(pdf, 6 * font_scale, _latin1_safe(f"- {line.text}"), width=width)
            pdf.set_text_color(0, 0, 0)
        else:
            pdf.set_text_color(*body_color)
            pdf.set_font(body_font, size=round(_BODY_FONT_SIZE * font_scale))
            _block(pdf, 6 * font_scale, _latin1_safe(line.text), width=width)
            pdf.set_text_color(0, 0, 0)


def _render_pdf_sidebar_main(
    pdf: FPDF,
    lines: list[_Line],
    profile: dict,
    *,
    body_font: str,
    body_color: tuple[int, int, int],
    font_scale: float,
    margin_mm: float,
) -> None:
    """Lays a SIDEBAR_MAIN StyleProfile (#99) out as a fixed-width sidebar
    plus a main column that reflows to whatever content it's given; both
    start at the same y (right below the title) and are rendered as two
    separate cursor passes since fpdf has no native multi-column text flow.
    Section order within each column still follows the Markdown's own order
    (#98's rule) — only the SIDEBAR/MAIN split itself comes from the
    StyleProfile.
    """
    sidebar_lines, main_lines = _group_lines_by_region(lines, profile)
    top_y = pdf.get_y()
    sidebar_x = margin_mm
    main_x = margin_mm + _SIDEBAR_WIDTH_MM + _COLUMN_GAP_MM
    main_width = pdf.w - main_x - margin_mm

    pdf.set_xy(sidebar_x, top_y)
    _render_pdf_lines(
        pdf, sidebar_lines, profile, body_font=body_font, body_color=body_color,
        font_scale=font_scale, width=_SIDEBAR_WIDTH_MM, x=sidebar_x,
    )

    pdf.set_xy(main_x, top_y)
    _render_pdf_lines(
        pdf, main_lines, profile, body_font=body_font, body_color=body_color,
        font_scale=font_scale, width=main_width, x=main_x,
    )


def _render_pdf(
    *, lines: list[_Line], profile: dict | None, margin_mm: float, font_scale: float
) -> FPDF:
    body_font = _FONT_FAMILY_TO_PDF_FONT.get(
        (profile or {}).get("fonts", {}).get("family"), "Helvetica"
    )
    body_color = _hex_to_rgb((profile or {}).get("accentColor")) or (0, 0, 0)

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=margin_mm)
    pdf.set_margins(margin_mm, margin_mm, margin_mm)
    pdf.add_page()

    if profile and profile.get("layoutArchetype") == "SIDEBAR_MAIN":
        _render_pdf_sidebar_main(
            pdf, lines, profile, body_font=body_font, body_color=body_color,
            font_scale=font_scale, margin_mm=margin_mm,
        )
    else:
        _render_pdf_lines(
            pdf, lines, profile, body_font=body_font, body_color=body_color,
            font_scale=font_scale, width=0,
        )

    return pdf


def _render_pdf_with_one_page_fit(*, lines: list[_Line], profile: dict) -> FPDF:
    """Walks _PDF_ONE_PAGE_FIT_LEVELS from the normal template down to the
    bounded floor, stopping at the first level whose render fits on one
    page. If even the floor spills, that floor render is returned as-is
    (#100) — tailored content long enough to still overflow is allowed to,
    rather than shrinking further past the readability floor.
    """
    pdf = None
    for margin_mm, font_scale in _PDF_ONE_PAGE_FIT_LEVELS:
        pdf = _render_pdf(lines=lines, profile=profile, margin_mm=margin_mm, font_scale=font_scale)
        if pdf.page_no() == 1:
            return pdf
    return pdf


def render_markdown_to_pdf(*, markdown_content: str, style_profile: dict | None = None) -> bytes:
    """Renders a GeneratedDocument's Markdown to PDF bytes using a single
    built-in template, starting directly with the document's own content
    (#105 — no auto-added title). Headings and bullets get their own
    styling; everything else is a plain paragraph. When `style_profile` is a
    SINGLE_COLUMN StyleProfile (#98), body text and each SectionType-tagged
    heading use that profile's font family and colors instead of the
    template default. A SIDEBAR_MAIN StyleProfile (#99) additionally splits
    rendering into a fixed-width sidebar and a reflowing main column per the
    StyleProfile's SIDEBAR/MAIN section assignment. When the profile also
    recorded `onePageFit` (#100), rendering attempts a bounded margin/font
    reduction to keep the tailored content on one page too, before allowing
    it to spill onto a second.
    """
    profile = _active_style_profile(style_profile)
    lines = _classify_lines(markdown_content)

    if profile and profile.get("onePageFit"):
        pdf = _render_pdf_with_one_page_fit(lines=lines, profile=profile)
    else:
        pdf = _render_pdf(lines=lines, profile=profile, margin_mm=_MARGIN_MM, font_scale=1.0)

    return bytes(pdf.output())


def _apply_docx_run_style(
    run, *, font_name: str | None, color: tuple[int, int, int] | None, font_size_pt: float | None
) -> None:
    if font_name:
        run.font.name = font_name
    if color:
        run.font.color.rgb = RGBColor(*color)
    if font_size_pt:
        run.font.size = Pt(font_size_pt)


def _docx_needs_one_page_reduction(*, profile: dict | None, lines: list[_Line]) -> bool:
    if not profile or not profile.get("onePageFit"):
        return False
    total_chars = sum(len(line.text) for line in lines if line.kind is not _LineKind.BLANK)
    return total_chars > _DOCX_ONE_PAGE_CHAR_BUDGET


def _add_docx_horizontal_rule(container) -> None:
    """python-docx has no native horizontal-rule element; a bottom-bordered
    empty paragraph is the standard workaround (#106)."""
    paragraph = container.add_paragraph()
    p_bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "auto")
    p_bdr.append(bottom)
    paragraph._p.get_or_add_pPr().append(p_bdr)


def _add_docx_line(
    container,
    line: _Line,
    profile: dict | None,
    *,
    body_font_name: str | None,
    body_color: tuple[int, int, int] | None,
    body_size: float | None,
    heading1_size: float | None,
    heading2_size: float | None,
) -> None:
    """Adds one classified line to `container` — a `Document` or a table
    `_Cell` (#99), both of which expose the same `add_paragraph(text,
    style=...)` shape that `Document.add_heading` itself is built on. Shared
    by the single-column path and each SIDEBAR_MAIN column (#99) so heading
    treatment/body styling behaves identically either way.
    """
    if line.kind in (_LineKind.HEADING1, _LineKind.HEADING2):
        level = 1 if line.kind is _LineKind.HEADING1 else 2
        paragraph = container.add_paragraph(line.text, style=f"Heading {level}")
        treatment = profile and _heading_treatment(profile, line.section_type)
        font_name = _docx_font_name(treatment.get("font")) if treatment else None
        color = _hex_to_rgb(treatment.get("color")) if treatment else None
        heading_size = heading1_size if line.kind is _LineKind.HEADING1 else heading2_size
        if font_name or color or heading_size:
            for run in paragraph.runs:
                _apply_docx_run_style(run, font_name=font_name, color=color, font_size_pt=heading_size)
    elif line.kind is _LineKind.HEADING3:
        # #106: never a profile's per-SectionType treatment here — CvTailoringAgent
        # only tags top-level headings, so this always uses the plain default style.
        container.add_paragraph(line.text, style="Heading 3")
    elif line.kind is _LineKind.RULE:
        _add_docx_horizontal_rule(container)
    elif line.kind is _LineKind.BULLET:
        paragraph = container.add_paragraph(line.text, style="List Bullet")
        for run in paragraph.runs:
            _apply_docx_run_style(run, font_name=body_font_name, color=body_color, font_size_pt=body_size)
    else:
        paragraph = container.add_paragraph(line.text)
        for run in paragraph.runs:
            _apply_docx_run_style(run, font_name=body_font_name, color=body_color, font_size_pt=body_size)


def _render_docx_sidebar_main(
    document: Document,
    lines: list[_Line],
    profile: dict,
    *,
    body_font_name: str | None,
    body_color: tuple[int, int, int] | None,
    body_size: float | None,
    heading1_size: float | None,
    heading2_size: float | None,
) -> None:
    """Lays a SIDEBAR_MAIN StyleProfile (#99) out as a two-cell, one-row
    table: a fixed-width sidebar cell for the StyleProfile's SIDEBAR
    SectionTypes and a wider main cell for everything else, mirroring the
    PDF renderer's split since python-docx has no native multi-column text
    flow either. Section order within each cell still follows the
    Markdown's own order (#98's rule).
    """
    sidebar_lines, main_lines = _group_lines_by_region(lines, profile)
    table = document.add_table(rows=1, cols=2)
    table.autofit = False
    sidebar_cell, main_cell = table.rows[0].cells
    sidebar_cell.width = _DOCX_SIDEBAR_WIDTH
    main_cell.width = _DOCX_MAIN_WIDTH

    for cell, cell_lines in ((sidebar_cell, sidebar_lines), (main_cell, main_lines)):
        for line in cell_lines:
            if line.kind is _LineKind.BLANK:
                continue
            _add_docx_line(
                cell, line, profile, body_font_name=body_font_name, body_color=body_color,
                body_size=body_size, heading1_size=heading1_size, heading2_size=heading2_size,
            )


def render_markdown_to_docx(*, markdown_content: str, style_profile: dict | None = None) -> bytes:
    """Renders a GeneratedDocument's Markdown to .docx bytes using a single
    built-in template, starting directly with the document's own content
    (#105 — no auto-added title), mirroring render_markdown_to_pdf's
    heading/bullet styling via python-docx's built-in Heading/List Bullet
    styles. When `style_profile` is a SINGLE_COLUMN StyleProfile (#98), body
    text and each SectionType-tagged heading get that profile's font and
    colors, with any font outside a small curated cross-platform set
    replaced by its family's entry instead of used literally (#100). A
    SIDEBAR_MAIN StyleProfile (#99) instead lays the same styled content out
    as a two-column table — a fixed-width sidebar cell and a wider main
    cell — split per the StyleProfile's SIDEBAR/MAIN section assignment.
    When that profile also recorded `onePageFit` and the tailored content
    crosses the same character-count proxy style_profile.py's extraction
    uses, margins drop to a bounded floor and every run gets an explicit,
    smaller font size (#100) — content long enough to still cross the
    budget at the floor is simply allowed to spill onto a second page.
    """
    profile = _active_style_profile(style_profile)
    lines = _classify_lines(markdown_content)
    body_font_name = _docx_font_name((profile or {}).get("fonts"))
    body_color = _hex_to_rgb((profile or {}).get("accentColor"))
    needs_reduction = _docx_needs_one_page_reduction(profile=profile, lines=lines)
    body_size = _BODY_FONT_SIZE * _FONT_SCALE_FLOOR if needs_reduction else None
    heading1_size = _DOCX_HEADING1_FONT_SIZE * _FONT_SCALE_FLOOR if needs_reduction else None
    heading2_size = _DOCX_HEADING2_FONT_SIZE * _FONT_SCALE_FLOOR if needs_reduction else None

    document = Document()
    if needs_reduction:
        section = document.sections[0]
        section.top_margin = Pt(_DOCX_MARGIN_FLOOR_PT)
        section.bottom_margin = Pt(_DOCX_MARGIN_FLOOR_PT)
        section.left_margin = Pt(_DOCX_MARGIN_FLOOR_PT)
        section.right_margin = Pt(_DOCX_MARGIN_FLOOR_PT)

    if profile and profile.get("layoutArchetype") == "SIDEBAR_MAIN":
        _render_docx_sidebar_main(
            document, lines, profile, body_font_name=body_font_name, body_color=body_color,
            body_size=body_size, heading1_size=heading1_size, heading2_size=heading2_size,
        )
    else:
        for line in lines:
            if line.kind is _LineKind.BLANK:
                continue
            _add_docx_line(
                document, line, profile, body_font_name=body_font_name, body_color=body_color,
                body_size=body_size, heading1_size=heading1_size, heading2_size=heading2_size,
            )

    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def render_markdown_to_text(*, markdown_content: str) -> str:
    """Strips Markdown heading syntax (`#`/`##`) and #97's SectionType
    comment tag for plain-text readability; bullet markers (`-`/`*`) are
    left as-is since they already read fine as plain text.
    """
    lines: list[str] = []
    for raw_line in markdown_content.splitlines():
        stripped = raw_line.strip()
        if _SECTION_TYPE_COMMENT_RE.fullmatch(stripped):
            continue
        if stripped.startswith("# "):
            lines.append(stripped.removeprefix("# "))
        elif stripped.startswith("## "):
            lines.append(stripped.removeprefix("## "))
        else:
            lines.append(raw_line)
    return "\n".join(lines)
