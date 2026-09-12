# Offer-tailored CV and cover letter are generated artifacts, not CV edits

The Scout capability (issue #52) needed a way to turn a relevant find into
application-ready documents. The obvious short cut — mutate the matched
`CVVersion.markdownContent` in place, or the underlying uploaded file — was
never on the table: it would silently invalidate every existing Analysis run
against that `CVVersion` (ADR 0001 made `markdownContent` the canonical
matching input) and any Scout still using it as a base. Instead, "Generate
documents" produces two new `GeneratedDocument` rows — `COVER_LETTER` and
`TAILORED_CV` — each carrying its own `markdownContent`, denormalised
`jobOfferId`/`cvVersionId`, and a `supersededById` self-link for a future
regenerate. The base `CVVersion` is never written to by generation.

Why: a CVVersion is a candidate's stable, reusable source of truth — the
thing a Scout matches against, other Analyses were run against, and the
candidate can inspect read-only (ADR 0001). An offer-tailored rewrite is
disposable, per-offer, and wrong for any offer but the one it was generated
for; treating it as an edit to the CVVersion would conflate those two
lifetimes and make "which CV did this Analysis actually see" unanswerable
after the fact. A separate row keeps the base CV immutable, keeps generation
retryable/regenerable without touching anything else, and keeps every
generated document traceable to the exact `Analysis` (and therefore the
exact `JobOffer` + `CVVersion` pair) that produced it.

This also settles the PRD §2 non-goal "auto-rewriting the candidate's CV
file" (echoed by ADR 0001 as "the PRD §8.1 non-goal" — that cross-reference
predates a section renumbering and should read §2; not corrected here since
fixing a stale citation in an already-shipped ADR is out of scope for this
slice). The non-goal itself is **not** reversed in the sense of now allowing
the stored CV to be rewritten — it is *clarified*: the boundary was always
"no silent mutation of the stored CV, not a general CV builder," and
generating a new, separate, offer-specific artifact the candidate reviews
and downloads was compatible with that boundary all along. See
[PRD.md §2](../../PRD.md#2-goals--non-goals) for the amended wording.

## Truthfulness constraint

Both the cover-letter and CV-tailoring agents (`services/analysis`) may
reorder, re-emphasise, and re-word only content the base CV's
`markdownContent` already contains. They must never fabricate employers,
dates, titles, or credentials, and every claim in the output must trace back
to something the base CV states. This is enforced in the agents' system
prompts, not by a separate validation pass — the same convention the
existing comparison/recommendation agents use for their own constraints.

## Consequences

- `GeneratedDocument.cvVersionId` is a `Restrict` FK: a `CVVersion` cannot be
  deleted while any generated document (or `Scout`, or `Application`)
  references it — the candidate must be told which rows block the delete.
- Regeneration (`supersededById`) creates a new row and points the previous
  one at it; only the newest non-superseded row per `(analysisId, type)` is
  shown. The superseded row is retained, not deleted — full history, never a
  live edit.
- A `GeneratedDocument`'s canonical content lives in Postgres
  (`markdownContent`); S3 (`generated/{userId}/{analysisId}/{type}.md`) is a
  mirror, not the source of truth — same split ADR 0001 established for
  `CVVersion.markdownContent`.
- PDF is rendered on demand from the Markdown at download time with a single
  built-in template; no PDF is stored. The tailored CV does not reproduce the
  uploaded CV's original visual design — deliberately out of scope, see the
  PRD.
- Output language follows the `JobOffer`'s detected language, falling back to
  the candidate's `Locale` — the document is generated for the offer's
  audience, not the candidate's own UI language by default.
