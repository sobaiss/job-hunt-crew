from dataclasses import dataclass
from enum import Enum
from io import BytesIO

from docx import Document
from fpdf import FPDF
from fpdf.enums import XPos, YPos

_MARGIN_MM = 20
_BODY_FONT_SIZE = 11
_HEADING_FONT_SIZE = 14
_TITLE_FONT_SIZE = 16


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


def _classify_lines(markdown_content: str) -> list[_Line]:
    """Splits a GeneratedDocument's Markdown into classified lines, shared by
    every renderer below. Deliberately not a full Markdown parser — the
    generation agents only ever produce this small subset (`#`/`##`
    headings, `-`/`*` bullets, blank lines, plain paragraphs — see
    cover_letter_writer_agent.py / cv_tailoring_agent.py).
    """
    lines: list[_Line] = []
    for raw_line in markdown_content.splitlines():
        line = raw_line.strip()
        if not line:
            lines.append(_Line(_LineKind.BLANK, ""))
        elif line.startswith("# "):
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


def render_markdown_to_pdf(*, title: str, markdown_content: str) -> bytes:
    """Renders a GeneratedDocument's Markdown to PDF bytes using a single
    built-in template. Headings and bullets get their own styling;
    everything else is a plain paragraph.
    """
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=_MARGIN_MM)
    pdf.set_margins(_MARGIN_MM, _MARGIN_MM, _MARGIN_MM)
    pdf.add_page()

    pdf.set_font("Helvetica", style="B", size=_TITLE_FONT_SIZE)
    _block(pdf, 10, _latin1_safe(title))
    pdf.ln(4)

    for line in _classify_lines(markdown_content):
        if line.kind is _LineKind.BLANK:
            pdf.ln(3)
        elif line.kind is _LineKind.HEADING1:
            pdf.set_font("Helvetica", style="B", size=_HEADING_FONT_SIZE)
            _block(pdf, 8, _latin1_safe(line.text))
        elif line.kind is _LineKind.HEADING2:
            pdf.set_font("Helvetica", style="B", size=_BODY_FONT_SIZE + 1)
            _block(pdf, 7, _latin1_safe(line.text))
        elif line.kind is _LineKind.BULLET:
            pdf.set_font("Helvetica", size=_BODY_FONT_SIZE)
            _block(pdf, 6, _latin1_safe(f"- {line.text}"))
        else:
            pdf.set_font("Helvetica", size=_BODY_FONT_SIZE)
            _block(pdf, 6, _latin1_safe(line.text))

    return bytes(pdf.output())


def render_markdown_to_docx(*, title: str, markdown_content: str) -> bytes:
    """Renders a GeneratedDocument's Markdown to .docx bytes using a single
    built-in template, mirroring render_markdown_to_pdf's heading/bullet
    styling via python-docx's built-in Heading/List Bullet styles.
    """
    document = Document()
    document.add_heading(title, level=0)

    for line in _classify_lines(markdown_content):
        if line.kind is _LineKind.BLANK:
            continue
        elif line.kind is _LineKind.HEADING1:
            document.add_heading(line.text, level=1)
        elif line.kind is _LineKind.HEADING2:
            document.add_heading(line.text, level=2)
        elif line.kind is _LineKind.BULLET:
            document.add_paragraph(line.text, style="List Bullet")
        else:
            document.add_paragraph(line.text)

    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def render_markdown_to_text(*, markdown_content: str) -> str:
    """Strips Markdown heading syntax (`#`/`##`) for plain-text readability;
    bullet markers (`-`/`*`) are left as-is since they already read fine as
    plain text.
    """
    lines: list[str] = []
    for raw_line in markdown_content.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("# "):
            lines.append(stripped.removeprefix("# "))
        elif stripped.startswith("## "):
            lines.append(stripped.removeprefix("## "))
        else:
            lines.append(raw_line)
    return "\n".join(lines)
