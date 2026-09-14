"""StyleProfile extraction (issue #96) — the visual look-and-feel Conversion
derives for a PDF/DOCX CVVersion, alongside its Markdown rendition. See
docs/adr/0008-tailored-cv-visual-style-profile.md.

Two passes, mirroring the ADR:
- Deterministic: real fonts, RGB colors, margins and a one-page-fit flag,
  read directly from the file (`pdfplumber` for PDF, `python-docx` for
  DOCX) — no LLM call.
- One LLM call for the two judgment calls a parser can't make reliably: the
  overall layout archetype (single-column vs sidebar-plus-main) and, per
  heading, its canonical SectionType plus — when the archetype is
  SIDEBAR_MAIN — which region it occupied.

`CVVersion.styleProfile`'s embedded-photo field is deliberately out of
scope here (cv_conversion.py always writes `photoAssetRef: null`) — no #96
acceptance criterion requires it, and extracting+storing binary image data
adds meaningfully more risk than the rest of this ticket. Revisit when #98
(rendering) actually needs a photo to show.
"""

import io
import json
import statistics
from collections import Counter
from typing import Literal

import pdfplumber
from docx import Document as DocxDocument
from py_db.models import Cvfiletype
from py_db.section_type import SectionType
from pydantic import BaseModel, ValidationError

from .llm_provider import LLMProvider

# A heading-sized run/char is one whose font size is at least this multiple
# of the document's body (most common) font size.
HEADING_SIZE_RATIO = 1.15

# python-docx exposes no page-layout engine, so DOCX has no reliable page
# count the way a PDF's page list gives one for free. This is a rough
# character-count proxy for "fits on one page" (~11pt, single-spaced,
# A4/Letter) — approximate by design, documented rather than hidden.
DOCX_ONE_PAGE_CHAR_BUDGET = 3500

# python-docx's own default template ("Normal" style) references a theme
# font python-docx doesn't resolve (the theme XML isn't parsed), so a run
# with no explicit font falls back to Word's own out-of-the-box default
# rather than reporting no font at all.
DOCX_DEFAULT_FONT_NAME = "Calibri"

MAX_MARKDOWN_CHARS = 8000
CLASSIFICATION_MAX_TOKENS = 2048

_SERIF_KEYWORDS = ("times", "georgia", "garamond", "cambria", "book", "serif", "georgia", "minion", "palatino")
_MONOSPACE_KEYWORDS = ("mono", "courier", "consolas", "menlo")

CLASSIFICATION_SYSTEM_PROMPT = (
    "You are given the Markdown rendition of a candidate's CV and the list "
    "of its section headings, in the original document's order. Decide two "
    "things: (1) the overall layout archetype — SINGLE_COLUMN if the "
    "original reads as one flowing column, SIDEBAR_MAIN if it has a "
    "distinct narrow side column (e.g. contact info, skills, languages) "
    "alongside a wider main column; (2) for every heading, its canonical "
    "SectionType from exactly this list: "
    f"{', '.join(t.value for t in SectionType)} (use OTHER when none fit), "
    "plus — only when the archetype is SIDEBAR_MAIN — which region, SIDEBAR "
    "or MAIN, that heading's section occupied in the original (use null for "
    "SINGLE_COLUMN). Respond with ONLY a single JSON object, no markdown "
    "fences, no commentary, matching this shape: "
    '{"layoutArchetype": "SINGLE_COLUMN"|"SIDEBAR_MAIN", "sections": '
    '[{"heading": string, "sectionType": string, "region": "SIDEBAR"|"MAIN"|null}]}.'
)


class StyleProfileError(Exception):
    pass


class _SectionClassification(BaseModel):
    heading: str
    sectionType: SectionType
    region: Literal["SIDEBAR", "MAIN"] | None = None


class _LayoutClassification(BaseModel):
    layoutArchetype: Literal["SINGLE_COLUMN", "SIDEBAR_MAIN"]
    sections: list[_SectionClassification]


def _classify_font_family(name: str | None) -> str:
    lowered = (name or "").lower()
    if any(keyword in lowered for keyword in _MONOSPACE_KEYWORDS):
        return "monospace"
    if any(keyword in lowered for keyword in _SERIF_KEYWORDS):
        return "serif"
    return "sans-serif"


def _font_descriptor(name: str | None) -> dict:
    return {"name": name, "family": _classify_font_family(name)}


def _color_to_hex(color) -> str | None:
    """Normalises a pdfplumber `non_stroking_color` (grayscale float/1-tuple,
    RGB 3-tuple, or CMYK 4-tuple, each channel 0..1) to `#RRGGBB`."""
    if color is None:
        return None
    if isinstance(color, int | float):
        channels = (color, color, color)
    elif len(color) == 1:
        channels = (color[0], color[0], color[0])
    elif len(color) == 3:
        channels = color
    elif len(color) == 4:
        c, m, y, k = color
        channels = ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    else:
        return None
    r, g, b = (max(0, min(255, round(v * 255))) for v in channels)
    return f"#{r:02X}{g:02X}{b:02X}"


def _extract_pdf_style(file_bytes: bytes) -> dict:
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        page_count = len(pdf.pages)
        first_page = pdf.pages[0]
        chars = first_page.chars
        if not chars:
            raise StyleProfileError("PDF has no character data on its first page")

        sizes = [c["size"] for c in chars]
        body_size = statistics.median(sizes)
        heading_threshold = body_size * HEADING_SIZE_RATIO
        body_chars = [c for c in chars if c["size"] < heading_threshold]
        heading_chars = [c for c in chars if c["size"] >= heading_threshold] or chars

        body_font = Counter(c["fontname"] for c in (body_chars or chars)).most_common(1)[0][0]
        heading_font = Counter(c["fontname"] for c in heading_chars).most_common(1)[0][0]

        body_colors = Counter(
            _color_to_hex(c["non_stroking_color"]) for c in (body_chars or chars)
        )
        heading_colors = Counter(_color_to_hex(c["non_stroking_color"]) for c in heading_chars)
        accent_color = next((color for color, _ in body_colors.most_common() if color), None)
        heading_color = next((color for color, _ in heading_colors.most_common() if color), None)

        left = min(c["x0"] for c in chars)
        right = first_page.width - max(c["x1"] for c in chars)
        top = min(c["top"] for c in chars)
        bottom = first_page.height - max(c["bottom"] for c in chars)

    return {
        "bodyFont": _font_descriptor(body_font),
        "headingFont": _font_descriptor(heading_font),
        "accentColor": accent_color,
        "headingColor": heading_color,
        "margins": {
            "top": round(top, 1),
            "bottom": round(bottom, 1),
            "left": round(left, 1),
            "right": round(right, 1),
        },
        "onePageFit": page_count <= 1,
    }


def _extract_docx_style(file_bytes: bytes) -> dict:
    doc = DocxDocument(io.BytesIO(file_bytes))
    section = doc.sections[0]

    body_fonts: Counter = Counter()
    heading_fonts: Counter = Counter()
    body_colors: Counter = Counter()
    heading_colors: Counter = Counter()
    total_chars = 0

    for paragraph in doc.paragraphs:
        text = paragraph.text
        if not text.strip():
            continue
        total_chars += len(text)
        style_name = (paragraph.style.name if paragraph.style else "") or ""
        is_heading = style_name.lower().startswith("heading") or style_name.lower() == "title"
        fonts = heading_fonts if is_heading else body_fonts
        colors = heading_colors if is_heading else body_colors
        runs = paragraph.runs or [None]
        for run in runs:
            name = (run.font.name if run else None) or DOCX_DEFAULT_FONT_NAME
            fonts[name] += 1
            rgb = None
            if run is not None and run.font.color is not None and run.font.color.type is not None:
                rgb = str(run.font.color.rgb)
            if rgb:
                colors[rgb] += 1

    body_font = body_fonts.most_common(1)[0][0] if body_fonts else DOCX_DEFAULT_FONT_NAME
    heading_font = heading_fonts.most_common(1)[0][0] if heading_fonts else body_font
    accent_color = f"#{body_colors.most_common(1)[0][0]}" if body_colors else None
    heading_color = f"#{heading_colors.most_common(1)[0][0]}" if heading_colors else None

    return {
        "bodyFont": _font_descriptor(body_font),
        "headingFont": _font_descriptor(heading_font),
        "accentColor": accent_color,
        "headingColor": heading_color,
        "margins": {
            "top": round(section.top_margin.pt, 1),
            "bottom": round(section.bottom_margin.pt, 1),
            "left": round(section.left_margin.pt, 1),
            "right": round(section.right_margin.pt, 1),
        },
        "onePageFit": total_chars <= DOCX_ONE_PAGE_CHAR_BUDGET,
    }


def _markdown_headings(markdown: str) -> list[str]:
    headings = []
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            headings.append(stripped.removeprefix("## ").strip())
        elif stripped.startswith("# "):
            headings.append(stripped.removeprefix("# ").strip())
    return headings


def _parse_classification(raw: str) -> _LayoutClassification:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[len("json") :]
    data = json.loads(text)
    return _LayoutClassification.model_validate(data)


def _classify_layout_and_sections(
    markdown: str, headings: list[str], *, llm_provider: LLMProvider
) -> _LayoutClassification:
    prompt = (
        "Headings (in order):\n"
        + "\n".join(f"- {h}" for h in headings)
        + "\n\nMarkdown:\n"
        + markdown[:MAX_MARKDOWN_CHARS]
    )
    raw = llm_provider.generate(
        system=CLASSIFICATION_SYSTEM_PROMPT, prompt=prompt, max_tokens=CLASSIFICATION_MAX_TOKENS
    )
    try:
        return _parse_classification(raw)
    except (json.JSONDecodeError, ValidationError, TypeError) as exc:
        raise StyleProfileError(f"malformed layout/section classification: {exc}") from exc


def build_style_profile(
    *,
    file_bytes: bytes,
    file_type: Cvfiletype,
    markdown: str,
    llm_provider: LLMProvider,
) -> dict:
    """Derives a StyleProfile dict for a PDF/DOCX CVVersion — deterministic
    font/color/margin/one-page-fit extraction plus one LLM call classifying
    the layout archetype and each heading's SectionType (+ sidebar/main
    region when applicable). Raises StyleProfileError on any failure; the
    caller (cv_conversion.py) is responsible for translating that into
    `styleStatus = FAILED` without touching `conversionStatus`.
    """
    if file_type == Cvfiletype.PDF:
        deterministic = _extract_pdf_style(file_bytes)
    elif file_type == Cvfiletype.DOCX:
        deterministic = _extract_docx_style(file_bytes)
    else:
        raise StyleProfileError(f"style extraction does not support {file_type}")

    headings = _markdown_headings(markdown)
    if not headings:
        raise StyleProfileError("no headings found in the Markdown rendition to classify")

    classification = _classify_layout_and_sections(markdown, headings, llm_provider=llm_provider)

    heading_treatment = {
        "font": deterministic["headingFont"],
        "color": deterministic["headingColor"],
    }
    sections = {
        item.sectionType.value: {
            "headingTreatment": heading_treatment,
            "region": item.region,
        }
        for item in classification.sections
    }

    return {
        "layoutArchetype": classification.layoutArchetype,
        "fonts": deterministic["bodyFont"],
        "accentColor": deterministic["accentColor"],
        "margins": deterministic["margins"],
        "onePageFit": deterministic["onePageFit"],
        "photoAssetRef": None,
        "sections": sections,
    }
