import re
from dataclasses import dataclass, replace
from enum import Enum
from io import BytesIO

from docx import Document
from docx.shared import Pt, RGBColor
from fpdf import FPDF
from fpdf.enums import XPos, YPos
from py_db.section_type import SectionType

_MARGIN_MM = 20
_BODY_FONT_SIZE = 11
_HEADING_FONT_SIZE = 14
_TITLE_FONT_SIZE = 16

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
_DOCX_TITLE_FONT_SIZE = 16
_DOCX_HEADING1_FONT_SIZE = 14
_DOCX_HEADING2_FONT_SIZE = 12

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
    BULLET = "bullet"
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
    generation agents only ever produce this small subset (`#`/`##`
    headings, `-`/`*` bullets, blank lines, plain paragraphs — see
    cover_letter_writer_agent.py / cv_tailoring_agent.py). A `<!--
    SectionType: X -->` comment right below a heading (#97) is stripped and
    attached to that heading instead of being emitted as its own line.
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
        if line.startswith("# "):
            lines.append(_Line(_LineKind.HEADING1, line.removeprefix("# ")))
        elif line.startswith("## "):
            lines.append(_Line(_LineKind.HEADING2, line.removeprefix("## ")))
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


def _block(pdf: FPDF, line_height: float, text: str) -> None:
    """multi_cell defaults to leaving the cursor at the right margin
    (new_x=XPos.RIGHT), which starves the next call of width. Every block in
    this template is meant to behave like a full-width paragraph, so the
    cursor is explicitly returned to the left margin on the next line.
    """
    pdf.multi_cell(0, line_height, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)


def _active_style_profile(style_profile: dict | None) -> dict | None:
    """A StyleProfile only styles rendering for the SINGLE_COLUMN archetype
    (#98) — SIDEBAR_MAIN falls back to the generic template until #99."""
    if style_profile is None or style_profile.get("layoutArchetype") != "SINGLE_COLUMN":
        return None
    return style_profile


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


def _render_pdf(
    *, title: str, lines: list[_Line], profile: dict | None, margin_mm: float, font_scale: float
) -> FPDF:
    body_font = _FONT_FAMILY_TO_PDF_FONT.get(
        (profile or {}).get("fonts", {}).get("family"), "Helvetica"
    )
    body_color = _hex_to_rgb((profile or {}).get("accentColor")) or (0, 0, 0)

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=margin_mm)
    pdf.set_margins(margin_mm, margin_mm, margin_mm)
    pdf.add_page()

    pdf.set_font("Helvetica", style="B", size=round(_TITLE_FONT_SIZE * font_scale))
    _block(pdf, 10 * font_scale, _latin1_safe(title))
    pdf.ln(4 * font_scale)

    for line in lines:
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
            _block(pdf, line_height, _latin1_safe(line.text))
            pdf.set_text_color(0, 0, 0)
        elif line.kind is _LineKind.BULLET:
            pdf.set_text_color(*body_color)
            pdf.set_font(body_font, size=round(_BODY_FONT_SIZE * font_scale))
            _block(pdf, 6 * font_scale, _latin1_safe(f"- {line.text}"))
            pdf.set_text_color(0, 0, 0)
        else:
            pdf.set_text_color(*body_color)
            pdf.set_font(body_font, size=round(_BODY_FONT_SIZE * font_scale))
            _block(pdf, 6 * font_scale, _latin1_safe(line.text))
            pdf.set_text_color(0, 0, 0)

    return pdf


def _render_pdf_with_one_page_fit(*, title: str, lines: list[_Line], profile: dict) -> FPDF:
    """Walks _PDF_ONE_PAGE_FIT_LEVELS from the normal template down to the
    bounded floor, stopping at the first level whose render fits on one
    page. If even the floor spills, that floor render is returned as-is
    (#100) — tailored content long enough to still overflow is allowed to,
    rather than shrinking further past the readability floor.
    """
    pdf = None
    for margin_mm, font_scale in _PDF_ONE_PAGE_FIT_LEVELS:
        pdf = _render_pdf(title=title, lines=lines, profile=profile, margin_mm=margin_mm, font_scale=font_scale)
        if pdf.page_no() == 1:
            return pdf
    return pdf


def render_markdown_to_pdf(
    *, title: str, markdown_content: str, style_profile: dict | None = None
) -> bytes:
    """Renders a GeneratedDocument's Markdown to PDF bytes using a single
    built-in template. Headings and bullets get their own styling;
    everything else is a plain paragraph. When `style_profile` is a
    SINGLE_COLUMN StyleProfile (#98), body text and each SectionType-tagged
    heading use that profile's font family and colors instead of the
    template default. When that profile also recorded `onePageFit` (#100),
    rendering attempts a bounded margin/font reduction to keep the tailored
    content on one page too, before allowing it to spill onto a second.
    """
    profile = _active_style_profile(style_profile)
    lines = _classify_lines(markdown_content)

    if profile and profile.get("onePageFit"):
        pdf = _render_pdf_with_one_page_fit(title=title, lines=lines, profile=profile)
    else:
        pdf = _render_pdf(title=title, lines=lines, profile=profile, margin_mm=_MARGIN_MM, font_scale=1.0)

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


def _docx_needs_one_page_reduction(*, profile: dict | None, title: str, lines: list[_Line]) -> bool:
    if not profile or not profile.get("onePageFit"):
        return False
    total_chars = len(title) + sum(len(line.text) for line in lines if line.kind is not _LineKind.BLANK)
    return total_chars > _DOCX_ONE_PAGE_CHAR_BUDGET


def render_markdown_to_docx(
    *, title: str, markdown_content: str, style_profile: dict | None = None
) -> bytes:
    """Renders a GeneratedDocument's Markdown to .docx bytes using a single
    built-in template, mirroring render_markdown_to_pdf's heading/bullet
    styling via python-docx's built-in Heading/List Bullet styles. When
    `style_profile` is a SINGLE_COLUMN StyleProfile (#98), body text and each
    SectionType-tagged heading get that profile's font and colors, with any
    font outside a small curated cross-platform set replaced by its family's
    entry instead of used literally (#100). When that profile also recorded
    `onePageFit` and the tailored content crosses the same character-count
    proxy style_profile.py's extraction uses, margins drop to a bounded
    floor and every run gets an explicit, smaller font size (#100) — content
    long enough to still cross the budget at the floor is simply allowed to
    spill onto a second page.
    """
    profile = _active_style_profile(style_profile)
    lines = _classify_lines(markdown_content)
    body_font_name = _docx_font_name((profile or {}).get("fonts"))
    body_color = _hex_to_rgb((profile or {}).get("accentColor"))
    needs_reduction = _docx_needs_one_page_reduction(profile=profile, title=title, lines=lines)
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

    title_paragraph = document.add_heading(title, level=0)
    if needs_reduction:
        for run in title_paragraph.runs:
            _apply_docx_run_style(run, font_name=None, color=None, font_size_pt=_DOCX_TITLE_FONT_SIZE * _FONT_SCALE_FLOOR)

    for line in lines:
        if line.kind is _LineKind.BLANK:
            continue
        elif line.kind in (_LineKind.HEADING1, _LineKind.HEADING2):
            level = 1 if line.kind is _LineKind.HEADING1 else 2
            paragraph = document.add_heading(line.text, level=level)
            treatment = profile and _heading_treatment(profile, line.section_type)
            font_name = _docx_font_name(treatment.get("font")) if treatment else None
            color = _hex_to_rgb(treatment.get("color")) if treatment else None
            heading_size = heading1_size if line.kind is _LineKind.HEADING1 else heading2_size
            if font_name or color or heading_size:
                for run in paragraph.runs:
                    _apply_docx_run_style(run, font_name=font_name, color=color, font_size_pt=heading_size)
        elif line.kind is _LineKind.BULLET:
            paragraph = document.add_paragraph(line.text, style="List Bullet")
            for run in paragraph.runs:
                _apply_docx_run_style(run, font_name=body_font_name, color=body_color, font_size_pt=body_size)
        else:
            paragraph = document.add_paragraph(line.text)
            for run in paragraph.runs:
                _apply_docx_run_style(run, font_name=body_font_name, color=body_color, font_size_pt=body_size)

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
