from fpdf import FPDF
from fpdf.enums import XPos, YPos

_MARGIN_MM = 20
_BODY_FONT_SIZE = 11
_HEADING_FONT_SIZE = 14
_TITLE_FONT_SIZE = 16


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
    built-in template. Headings (`#`) and bullet lines (`-`/`*`) get their
    own styling; everything else is a plain paragraph. Deliberately not a
    full Markdown parser — the generation agents only ever produce this
    small subset (see cover_letter_writer_agent.py / cv_tailoring_agent.py).
    """
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=_MARGIN_MM)
    pdf.set_margins(_MARGIN_MM, _MARGIN_MM, _MARGIN_MM)
    pdf.add_page()

    pdf.set_font("Helvetica", style="B", size=_TITLE_FONT_SIZE)
    _block(pdf, 10, _latin1_safe(title))
    pdf.ln(4)

    for raw_line in markdown_content.splitlines():
        line = raw_line.strip()
        if not line:
            pdf.ln(3)
            continue
        if line.startswith("# "):
            pdf.set_font("Helvetica", style="B", size=_HEADING_FONT_SIZE)
            _block(pdf, 8, _latin1_safe(line.removeprefix("# ")))
        elif line.startswith("## "):
            pdf.set_font("Helvetica", style="B", size=_BODY_FONT_SIZE + 1)
            _block(pdf, 7, _latin1_safe(line.removeprefix("## ")))
        elif line.startswith(("- ", "* ")):
            pdf.set_font("Helvetica", size=_BODY_FONT_SIZE)
            _block(pdf, 6, _latin1_safe(f"- {line[2:]}"))
        else:
            pdf.set_font("Helvetica", size=_BODY_FONT_SIZE)
            _block(pdf, 6, _latin1_safe(line))

    return bytes(pdf.output())
