# Tailored CV rendering reproduces the base CVVersion's visual style via a derived StyleProfile

ADR 0003 and PRD §2 treated "the tailored CV does not reproduce the uploaded
CV's original visual design" as a deliberate non-goal — TAILORED_CV rendering
used a single generic PDF template regardless of what the candidate actually
uploaded. Candidate feedback showed this doesn't hold up: a generated CV that
looks nothing like the candidate's real CV undercuts the point of a
*tailored* document. This ADR reverses that specific non-goal for
TAILORED_CV — not COVER_LETTER — without touching anything else ADR 0003
established: GeneratedDocument stays a new row, never a CVVersion edit; the
truthfulness constraint is untouched; no rendered file is stored.

## Decision

- Conversion (the existing CVVersion → Markdown step) additionally derives a
  **StyleProfile** for a PDF/DOCX upload: deterministic extraction (real
  fonts, RGB colors, margins, read from the file) plus one LLM call for
  layout archetype and per-section classification into a canonical
  **SectionType** (SUMMARY, EXPERIENCE, EDUCATION, SKILLS, LANGUAGES, ...,
  OTHER). Cached on `CVVersion.styleProfile`, computed once — no backfill
  for an existing CVVersion; a candidate gets one by replacing their CV
  (ADR 0005).
- `CVVersion.styleStatus` tracks that extraction independently of
  `conversionStatus`: an MD/TXT-origin upload has no StyleProfile, and a
  failed extraction never fails Conversion or blocks matching (ADR 0001) —
  TAILORED_CV rendering just falls back to the existing generic template
  (`pdf_render.py`).
- A StyleProfile records style **per SectionType** (heading treatment,
  sidebar-vs-main region) — never the original's literal section order or
  heading text. Rendering follows the *tailored content's own* section
  order, since CvTailoringAgent's relevance-based reordering is a deliberate
  feature of tailoring (ADR 0003), not a defect to override. CvTailoringAgent
  now tags each heading it writes with its SectionType directly, so
  rendering never needs a second classification pass over generated content.
- Fidelity is adaptive, not pixel-perfect: content reflows to its natural
  length rather than being forced into fixed boxes. A sidebar's short,
  stable content (contact info, skills) keeps its position while the main
  column reflows. An original that fit one page gets a bounded margin/font
  shrink attempt before a second page is allowed. A Word render substitutes
  an unavailable original font with the closest of a small curated
  serif/sans-serif/monospace set, since Word can't embed arbitrary fonts.
  The candidate's photo, if present in the original, is reused as-is — it's
  a visual element, not a fact bound by the truthfulness constraint.
- Scope stays narrow: only TAILORED_CV gets style-matching; COVER_LETTER
  keeps the generic template, since it has no original document to imitate.
  Both gain PDF, Word, Markdown, and plain text as download formats,
  independent of style-matching — Markdown/Text are inherently unstyled
  regardless, and are just `markdownContent` (Markdown) or the same content
  with heading syntax stripped (Text).

## Consequences

- `CVVersion` gains `styleProfile` (nullable) and `styleStatus` alongside
  `markdownContent`/`conversionStatus`.
- GeneratedDocument rendering still stores nothing: PDF/Word/Markdown/Text
  are all rendered on demand from `markdownContent` (using the base
  CVVersion's StyleProfile when the document is a TAILORED_CV with one) —
  ADR 0003's "no PDF is stored" invariant extends unchanged to the new
  formats.
- `pdf_render.py`'s single built-in template remains the fallback path
  (MD/TXT-origin CVVersion, failed extraction, or any COVER_LETTER) — not
  replaced.
- PRD §2's non-goal is amended a second time (see PRD.md).
