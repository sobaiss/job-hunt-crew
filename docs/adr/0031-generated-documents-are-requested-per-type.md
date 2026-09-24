# GeneratedDocuments are requested per type, not as a pair

`POST /v1/analyses/{id}/generated-documents` created a `COVER_LETTER` *and* a `TAILORED_CV` in one call, and the panel behind it offered one "Générer les documents" button. A candidate who only wanted a cover letter paid two documents of `DOCUMENTS_DAILY` quota for it. We decided the endpoint takes an optional `type`: naming one produces that one, omitting it still produces both.

Why: "documents come in pairs" was never a domain rule, only the shape of the first screen that needed them. It had leaked into the quota accounting, into the panel's all-or-nothing gate, and into "Postuler" — three places that each had to be undone here, which is why this is worth writing down rather than leaving to the diff.

## Considered options

- **A separate endpoint per type**, `POST .../cover-letter` and `POST .../tailored-cv`. Rejected: the two differ by one enum value and nothing else — same ownership check, same `COMPLETED` precondition, same Application get-or-create, same quota, same queue. Two routes would be one route copied.
- **Keeping the pair and adding a "generate the other one" action.** Rejected: it names the second document by what it is not, and still bills the first call for two.

## Consequences

- **The quota is no longer a fixed price per call.** `effective_quota` is still pre-checked the same way (`used >= cap` rejects with 429), but what a call *spends* is now the number of rows it creates — 1 or 2. A cap of 2 buys two single-document calls where it only ever bought one pair. `maybe_record_quota_alert` already took `used_after = used + len(documents)`, so it needed no change; anything counting "calls" rather than rows would be wrong.
- **Each panel slot gates on its own document, not on "any documents exist".** The old gate (`!documents`) was safe only while generating was all-or-nothing: with a per-type call it would hide the Générer button the moment the *first* document appeared, leaving the second unreachable for good. Each slot also owns its own create mutation, so one generation in flight does not disable the other's button.
- **"Postuler" no longer waits for the pair.** It enables on the first `READY` document and downloads what exists. Keeping the both-ready rule would have left a candidate who deliberately asked for one document facing a permanently greyed button, with nothing on screen explaining why. "Télécharger les deux" is unchanged — it still appears only when there are two.
- **The bulk action and the Admin table send no `type` and are untouched**, which is also what makes the change backward-compatible: every caller written before this keeps its old behaviour by saying nothing.
- **Nothing stops a client asking for a type it already has.** The endpoint has no "already generated" check — it did not have one before either (the UI was the only guard), and a duplicate row would be hidden by `list_generated_documents`' first-match-per-type read while still costing quota. Unchanged here, and still worth closing if a caller other than the panel ever appears.
