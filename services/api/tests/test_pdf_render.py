from api.pdf_render import render_markdown_to_pdf


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
