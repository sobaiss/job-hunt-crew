# CV Conversion is triggered by the client, after the upload it just finished

A CV upload is two hops: the API context creates the `CVVersion` row and hands back a presigned URL, then the *browser* PUTs the bytes straight to S3 (PRD Section 9.2). That means the API cannot start Conversion when `POST /v1/cv-versions` returns — at that moment the file it would convert does not exist yet. We decided the client owns the trigger: once its PUT succeeds, it calls `POST /v1/cv-versions/{id}/convert` itself, and the API refuses to enqueue a Conversion for a `fileKey` that has no object behind it.

Why: this is the only ordering that is true by construction rather than by timing. The alternative the code actually shipped first — enqueue at create/replace time and hope the PUT wins the race — is what this ADR exists to retire.

## Considered options

- **An S3 event notification feeding the `cv-conversion` queue.** The genuinely server-side answer: the object landing *is* the trigger, no browser involved, and a candidate who closes the tab mid-upload still gets a converted CV. Rejected for cost, not correctness — it needs bucket notification config in the deployed stack *and* an equivalent MinIO event setup in `docker-compose.yml`, for a flow whose client is already online and waiting on the result. This is the option to revisit if Conversion ever needs to start without a browser.
- **Enqueue inside `POST /v1/cv-versions`, as `replace` already did.** This is the status quo being reversed. `replace_cv_version` sent its `cv-conversion` message immediately after committing the new row, before the caller's PUT had run. `convert_cv` then called `s3.get_object` unguarded, having already flipped the row to `CONVERTING`, and `handle_cv_conversion` only swallows `CVConversionError` — so a `NoSuchKey` left the row stuck at `CONVERTING` forever, with the manual Convert action answering 409 because a Conversion "was already running". The race was invisible only because the local worker's poll usually lost to the browser's PUT.
- **Enqueue at create time with an SQS `DelaySeconds`.** Trades a race for a bet on how long an upload takes. Rejected outright.

## Consequences

- `replace_cv_version` no longer enqueues anything. Every caller that replaces a CVVersion — the CV panel's Replace form, and the import screen's "Remplacer le fichier" recovery on a failed Conversion — must call `convert` after its own PUT, exactly as a fresh import does. One rule now covers both paths: *the file first, the Conversion second.*
- `convert_cv_version` performs a `head_object` (via `make_internal_s3_client`) before enqueuing, and rejects a missing object with a 409 carrying `{"code": "FILE_NOT_UPLOADED"}`. Its pre-existing "already running" 409 gains `{"code": "CONVERSION_RUNNING"}` so the two can be told apart by machine rather than by message text — the same shape `USER_BLOCKED` already uses.
- That guard doubles as a state detector the client has no other way to get. A candidate who reloads the import screen mid-upload aborts the PUT; on resume the screen calls `convert` and reads `FILE_NOT_UPLOADED` as "this upload never finished", instead of polling a `PENDING` row that nothing will ever advance.
- A CVVersion whose bytes reached S3 but whose `convert` call did not reach the API stays `PENDING` with a valid file behind it. It is not an error state and never gets cleaned up: the manual "Convertir en Markdown" action on the CV-versions table recovers it, which is what that action was for.
- Conversion still cannot start for a candidate who closes the tab between the PUT and the `convert` call. Accepted: the window is one request wide, the recovery is one click, and closing it is exactly what the S3-notification option above would buy.
