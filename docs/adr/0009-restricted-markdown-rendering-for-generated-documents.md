# GeneratedDocument rendering drops the injected title and hand-rolls a small, shared Markdown subset instead of a full parser

CvTailoringAgent and CoverLetterWriterAgent's prompts (analysis/CONTEXT.md)
ask for "Markdown prose" with no hard constraint on which constructs they
use. `document_render.py`'s line classifier was built on the assumption
that "the generation agents only ever produce this small subset" (`#`/`##`
headings, `-`/`*` bullets, plain paragraphs) — deliberately not a full
Markdown parser. That assumption didn't hold: models routinely reach for
`###` sub-headings, `---` dividers, and inline `**bold**`/`*italic*`
emphasis, none of which the classifier recognized, so they leaked as
literal characters into every rendered surface — PDF, DOCX, and (found
while scoping this fix) the web in-app preview's raw `<pre>` block too.
Separately, `get_generated_document_download` auto-injects a
`"{Label} — {JobOffer.title}"` heading at render time that was never part
of `GeneratedDocument.markdownContent` and doesn't belong in candidate-
facing output.

## Decision

- The auto-injected title is removed from PDF/DOCX rendering entirely, for
  both TAILORED_CV and COVER_LETTER — the rendered document now starts
  directly with `markdownContent`, exactly as authored.
- The shared line classifier (still deliberately not a full Markdown
  parser) is extended to a fixed target set and no further: `#`/`##`/`###`
  headings, `-`/`*` bullets, inline `**bold**`/`*italic*` emphasis, and
  `---` horizontal rules. Anything outside that set (links, tables,
  numbered lists, blockquotes) still renders as literal text; the
  generation agents' prompts are tightened to stay inside it.
- `#`/`##` already round-tripped correctly (Heading 1/2) and are unchanged.
  `###` is new: it gets its own heading level but never a StyleProfile
  color/font treatment (ADR 0008's SectionType styling is keyed only to
  headings CvTailoringAgent explicitly tags, and it only tags top-level
  section headings) — `###` always renders in the template's plain default
  sub-heading style, regardless of StyleProfile.
- The restricted set is implemented by hand, independently, in three
  places — PDF (fpdf2), DOCX (python-docx), and a new web-preview
  renderer (apps/web, TypeScript) — rather than adopting a full Markdown
  library in any of them:
  - fpdf2 ships a built-in `markdown=True` mode, deliberately not used:
    its dialect doesn't match standard Markdown (`__x__` for italics,
    `--x--` for underline, no heading syntax at all), so enabling it would
    misrender exactly the syntax the LLM naturally produces.
  - The web preview gets a small TypeScript renderer matching the same
    restricted set, not a general-purpose library (e.g. react-markdown):
    the preview's entire value is showing the candidate what they're about
    to download, so it must render exactly what the backend renders — no
    more, no less. A full-featured library would render constructs (tables,
    links, nested lists) the download can't reproduce.
  - The web preview also stops leaking CvTailoringAgent's
    `<!-- SectionType: X -->` tag (already stripped in PDF/DOCX, missed in
    the preview) — same pass, same fix.
- Scope stays GeneratedDocument only. CVVersion's own Markdown-rendition
  preview (`cv-version-panel.tsx` — the uploaded/converted base CV, not a
  generated one) is untouched; it keeps showing raw Markdown.

## Consequences

- Three independent renderers now share one small Markdown "spec" that
  must be kept in sync by hand — adding any construct later (links,
  tables, numbered lists) means touching PDF, DOCX, and the web renderer,
  not one shared library config.
- `_docx_needs_one_page_reduction` and the PDF one-page-fit ladder (#100)
  drop the removed title's length from their character-budget heuristics.
- `download`'s `filename` is unaffected — it was already built from
  `label`/`document.id`, never from the injected title.
