# Replacing a CV supersedes the CVVersion row; it never mutates or deletes it

Adding a "replace CV" action raised the same question ADR 0001 and ADR 0003
already answered for the matching input and for generated documents: can a
CVVersion's stored file ever be overwritten? Overwriting it in place was
rejected for the same reason ADR 0003 gives for `GeneratedDocument` — it would
retroactively change what every `Analysis`, `Scout`, `Application`, and
`GeneratedDocument` that already reference that `CVVersion` actually saw.
Deleting the old `CVVersion` outright was also rejected, for a sharper reason:
unlike `Scout`/`Application`/`GeneratedDocument`, `Analysis.cvVersionId` and
`IngestionJob.cvVersionId` are `Cascade` foreign keys — deleting a `CVVersion`
silently deletes every `Analysis` and `IngestionJob` ever run against it, even
ones with no `Application` or `Scout` of their own. Instead, "Replace" creates
a new `CVVersion` and sets `supersededById` on the old one — the same
self-link pattern `GeneratedDocument` already uses for regeneration.

## Consequences

- `CVVersion` gains a nullable, unique `supersededById` self-link, mirroring
  `GeneratedDocument.supersededById`.
- A superseded `CVVersion` is excluded from `CvVersionPicker` and from
  `/cv-versions`'s default view (an explicit filter reveals it) and no longer
  counts toward the Dashboard's CV-version count — but stays fully intact for
  every `Analysis`/`Application`/`GeneratedDocument`/`Scout` still pointing at
  it.
- A `Scout` still pointing at a just-superseded `CVVersion` is not repointed
  automatically — a `Scout` is a live, separately-configured object (ADR 0003
  calls a `CVVersion` "the thing a Scout matches against"), and silently
  changing its matching input would be the same kind of silent mutation this
  decision avoids for the `CVVersion` itself. The candidate is warned and
  linked to each affected Scout's edit form instead.
- `delete_cv_version` gained the `GeneratedDocument` reference check it was
  missing (it already checked `Scout` and `Application`) — surfaced while
  auditing this path, since ADR 0003 already documented that check as a
  stated consequence.
