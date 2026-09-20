# Cover letter sender/recipient address-block layout is out of scope

Google's cover-letter guidance also calls for a French business-letter
layout: sender's coordinates top-left, recipient's top-right, followed by
the date and an "Objet" line. Only the date and Objet line were implemented
(as plain Markdown text at the top of the letter body, French-gated); the
positioned address blocks were deliberately left out.

Why: none of the pieces needed for real address blocks exist today.
`GeneratedDocument.markdownContent` is rendered as a single Markdown
document with no positioned/columnar layout support in any of its three
independent renderers (PDF, DOCX, web preview) — cover letters in
particular are never rendered against a `StyleProfile` (the mechanism that
gives `TAILORED_CV` its two-column layout, docs/adr/0008), so there is no
existing seam to hang a two-column address header on. The data is also
missing: Redaction strips the candidate's postal address before the base
CV ever reaches the writer agents (docs/adr/0022), and no JobOffer field
captures the recipient's mailing address. Building this properly would mean
new structured fields threaded through generation, storage, and all three
renderers — a materially larger project than a prompt fix.

## Consequences

- Generated French cover letters get a dated "Objet : Candidature au poste
  de ..." line, but not a positioned sender/recipient address header.
- If true address-block layout is wanted later, it needs new structured
  fields (candidate postal address, recipient address) and rendering
  changes in `services/api/src/api/document_render.py` and the web
  preview's renderer, not just a prompt change.
