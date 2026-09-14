from io import BytesIO

from docx import Document

from api.document_render import (
    render_markdown_to_docx,
    render_markdown_to_pdf,
    render_markdown_to_text,
)


def test_render_markdown_to_pdf_returns_pdf_bytes():
    pdf_bytes = render_markdown_to_pdf(title="Cover Letter", markdown_content="Hello world")
    assert pdf_bytes.startswith(b"%PDF")


def test_render_markdown_to_pdf_handles_headings_and_bullets():
    markdown_content = "# Heading\n\nSome paragraph text.\n\n- First bullet\n- Second bullet\n"
    pdf_bytes = render_markdown_to_pdf(title="Tailored CV", markdown_content=markdown_content)
    assert pdf_bytes.startswith(b"%PDF")
    assert len(pdf_bytes) > 0


def test_render_markdown_to_pdf_handles_empty_content():
    pdf_bytes = render_markdown_to_pdf(title="Empty", markdown_content="")
    assert pdf_bytes.startswith(b"%PDF")


def test_render_markdown_to_pdf_handles_characters_outside_latin1():
    pdf_bytes = render_markdown_to_pdf(
        title="Café — Résumé", markdown_content="Smart quotes: “quoted” and an em dash — here."
    )
    assert pdf_bytes.startswith(b"%PDF")


def test_render_markdown_to_docx_returns_zip_signature():
    docx_bytes = render_markdown_to_docx(title="Cover Letter", markdown_content="Hello world")
    assert docx_bytes.startswith(b"PK")


def test_render_markdown_to_docx_handles_headings_and_bullets():
    markdown_content = "# Heading\n\n## Subheading\n\nSome paragraph text.\n\n- First bullet\n- Second bullet\n"
    docx_bytes = render_markdown_to_docx(title="Tailored CV", markdown_content=markdown_content)
    assert docx_bytes.startswith(b"PK")
    assert len(docx_bytes) > 0


def test_render_markdown_to_docx_handles_empty_content():
    docx_bytes = render_markdown_to_docx(title="Empty", markdown_content="")
    assert docx_bytes.startswith(b"PK")


def test_render_markdown_to_text_strips_heading_syntax():
    markdown_content = "# Heading\n\n## Subheading\n\nSome paragraph text.\n"
    text = render_markdown_to_text(markdown_content=markdown_content)
    assert "# Heading" not in text
    assert "## Subheading" not in text
    assert "Heading" in text
    assert "Subheading" in text
    assert "Some paragraph text." in text


def test_render_markdown_to_text_leaves_bullets_as_is():
    markdown_content = "- First bullet\n* Second bullet\n"
    text = render_markdown_to_text(markdown_content=markdown_content)
    assert "- First bullet" in text
    assert "* Second bullet" in text


def test_render_markdown_to_text_handles_empty_content():
    assert render_markdown_to_text(markdown_content="") == ""


def test_render_markdown_to_text_strips_section_type_comment():
    markdown_content = "## Experience\n<!-- SectionType: EXPERIENCE -->\n\nDid things.\n"
    text = render_markdown_to_text(markdown_content=markdown_content)
    assert "SectionType" not in text
    assert "Experience" in text
    assert "Did things." in text


def test_render_markdown_to_docx_strips_section_type_comment():
    markdown_content = "## Experience\n<!-- SectionType: EXPERIENCE -->\n\nDid things.\n"
    docx_bytes = render_markdown_to_docx(title="Tailored CV", markdown_content=markdown_content)
    document = Document(BytesIO(docx_bytes))
    text = "\n".join(p.text for p in document.paragraphs)
    assert "SectionType" not in text
    assert "Experience" in text


_STYLE_PROFILE = {
    "layoutArchetype": "SINGLE_COLUMN",
    "fonts": {"name": "Georgia", "family": "serif"},
    "accentColor": "#112233",
    "margins": {"top": 40, "bottom": 40, "left": 40, "right": 40},
    "onePageFit": True,
    "photoAssetRef": None,
    "sections": {
        "EXPERIENCE": {
            "headingTreatment": {"font": {"name": "Impact", "family": "sans-serif"}, "color": "#FF0000"},
            "region": None,
        }
    },
}


def test_render_markdown_to_docx_applies_style_profile_heading_treatment():
    markdown_content = "## Experience\n<!-- SectionType: EXPERIENCE -->\n\nDid things.\n"
    docx_bytes = render_markdown_to_docx(
        title="Tailored CV", markdown_content=markdown_content, style_profile=_STYLE_PROFILE
    )
    document = Document(BytesIO(docx_bytes))
    heading_paragraph = next(p for p in document.paragraphs if p.text == "Experience")
    run = heading_paragraph.runs[0]
    assert run.font.name == "Impact"
    assert str(run.font.color.rgb) == "FF0000"

    body_paragraph = next(p for p in document.paragraphs if p.text == "Did things.")
    body_run = body_paragraph.runs[0]
    assert body_run.font.name == "Georgia"
    assert str(body_run.font.color.rgb) == "112233"


def test_render_markdown_to_docx_ignores_style_profile_for_sidebar_main():
    style_profile = {**_STYLE_PROFILE, "layoutArchetype": "SIDEBAR_MAIN"}
    markdown_content = "## Experience\n<!-- SectionType: EXPERIENCE -->\n\nDid things.\n"
    docx_bytes = render_markdown_to_docx(
        title="Tailored CV", markdown_content=markdown_content, style_profile=style_profile
    )
    document = Document(BytesIO(docx_bytes))
    body_paragraph = next(p for p in document.paragraphs if p.text == "Did things.")
    assert body_paragraph.runs[0].font.name is None


def test_render_markdown_to_pdf_applies_style_profile_without_error():
    markdown_content = "## Experience\n<!-- SectionType: EXPERIENCE -->\n\nDid things.\n"
    pdf_bytes = render_markdown_to_pdf(
        title="Tailored CV", markdown_content=markdown_content, style_profile=_STYLE_PROFILE
    )
    assert pdf_bytes.startswith(b"%PDF")
