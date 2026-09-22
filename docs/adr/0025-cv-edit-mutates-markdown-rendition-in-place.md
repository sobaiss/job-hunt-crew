# Editing a CVVersion mutates its Markdown rendition in place, not via supersede

Adding a candidate-facing "Edit CV" page raised the same question ADR 0001, ADR 0003, and ADR 0005 already answered for the matching input, for generated documents, and for file replacement: can `CVVersion.markdownContent` ever change on the same row? We're deliberately answering it differently here: saving an edit writes the candidate's typed text straight into the existing `CVVersion.markdownContent`, on the same row, with no new `CVVersion` and no `supersededById` link — reversing, for this one action, the "read-only" (ADR 0001) / "never mutated" (ADR 0003, ADR 0005) guarantee the rest of the CV lifecycle is built on.

Why: a candidate correcting their own CV text is closer to fixing a typo than to producing a new artifact, and the product wants that to feel like editing a document, not filing a replacement. That's a deliberate trade: retroactive traceability ("which CV did this Analysis actually see") is given up in exchange for a plain, single-row edit with no new-version ceremony.

## Considered options

- **Supersede, Replace-shaped** (ADR 0005's existing mechanism, just fed by typed text instead of an uploaded file): creates a new `CVVersion`, points the old row's `supersededById` at it, re-enqueues Conversion so the new row's rendition still gets Redaction's minimal-diff pass. Keeps every existing ADR intact and every past Analysis/Scout/GeneratedDocument insulated from the edit. Rejected in favor of the simpler in-place edit despite this cost.

## Consequences

- Every `Analysis`, `Scout`, `Application`, and `GeneratedDocument` that already reference this `CVVersion` sees the edited text immediately and retroactively — re-opening a past Analysis's "CV used" no longer reflects what was actually compared at the time. This is the exact failure mode ADR 0003 named as the reason generation never mutates `CVVersion`; here it's accepted, not avoided.
- No redaction re-check runs on save (ADR 0022's minimal-diff LLM pass and deterministic safety net are both part of Conversion, which this path doesn't invoke). `markdownContent` can therefore hold unredacted identity data the candidate typed in — the candidate is the only safeguard, unlike every other write to this field.
- `fileName`, `fileType`, `fileKey`, `styleProfile`, and `styleStatus` are left untouched by an edit — they keep describing the original upload even after `markdownContent` no longer matches it.
- "Reconvertir" stays available and unchanged on an edited row. Since it re-extracts from the original file still sitting at `fileKey`, running it after an edit silently discards the hand-typed text and replaces it with a fresh extraction of the pre-edit file.
- No history of the pre-edit content is kept anywhere — the one candidate-facing, content-changing action on a `CVVersion` that is neither append-only nor supersede-based. The Edit page requires an explicit confirmation step before saving to partially offset the missing undo.
- Only reachable for a `CVVersion` that is not superseded and already has a converted rendition (`conversionStatus === CONVERTED`) — the same non-superseded eligibility Replace already uses, plus a "there must be something to edit" precondition Replace doesn't need.
