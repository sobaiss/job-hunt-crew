# CV deletion is reintroduced, gated on Analysis/IngestionJob usage across the whole chain

ADR 0005 rejected deleting a CVVersion outright because `Analysis.cvVersionId`
and `IngestionJob.cvVersionId` are `onDelete: Cascade` — a delete would
silently wipe every Analysis and IngestionJob ever run against it, even ones
with no Application or Scout of their own. It reached for Replace instead,
and `delete_cv_version` was left guarding only the three `Restrict`
relations (Scout, Application, GeneratedDocument) the database already
enforces on its own; Analysis and IngestionJob were left unchecked
specifically because there was no safe way to delete a CVVersion that had
either.

`/cv-versions` now needs a delete action for a CV nobody has ever analysed.
Rather than continue avoiding delete altogether, `delete_cv_version` performs
the check the FK constraints don't: it looks up every Analysis and
IngestionJob referencing any CVVersion in the CV's chain (see CONTEXT.md's
CV entry) and refuses the delete (409) if either exists, regardless of
status. This makes deletion safe for exactly the case ADR 0005 was silent
on, without reopening the risk ADR 0005 was written to avoid.

Two consequences follow from treating "CV" as the whole `supersededById`
chain rather than the single row a request names:

- Deletion always acts on the entire chain (every superseded CVVersion plus
  the current one) in one transaction. A partial delete — removing only the
  current row — would leave older superseded rows orphaned with no current
  successor and no way to reach them again, since Replace already refuses to
  act on an already-superseded row.
- The pre-existing Scout/Application/GeneratedDocument checks, previously
  scoped to the single targeted row, now also run across the whole chain —
  an old superseded row still referenced by one of them would otherwise hit
  Postgres's `Restrict` constraint directly mid-delete and surface a raw
  integrity error instead of the existing 409 shape.

`isDefault` is deliberately not part of the eligibility check: the system
already treats "no default CV" as a normal, pre-existing state (a new
candidate has none until their first "Set default"), so deleting the
default CV just returns the account to that same state rather than needing
a guard of its own.
