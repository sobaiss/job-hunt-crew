# API

The FastAPI service that is the sole owner of Postgres, S3, and SQS for synchronous, user-facing data — CRUD, presigned uploads, SQS enqueue. Reachable only from the [Web](../../apps/web/CONTEXT.md) context's BFF proxy, authenticated by a shared internal secret. Defines the core entities the [Ingestion](../ingestion/CONTEXT.md), [Analysis](../analysis/CONTEXT.md), and [Scout](../scout/CONTEXT.md) contexts read and write directly against the same tables.

## Language

**User**:
The account record for one person who signs in — a candidate, a support user, or an Administrator, depending on their Role — identified by email, keyed by the canonical `userId` every other entity here is scoped to.
_Avoid_: Candidate, account — "candidate" names the persona in product conversations; `User` is the row every context actually references.

**Plan**:
A usage tier — `free` | `standard` | `premium` — determining quota defaults (see PlanQuotaDefault) for whichever User holds it through their current Subscription. `free`'s Subscription never expires, but its PlanQuotaDefault ceilings are the lowest of the three (docs/adr/0021) — unbounded duration and quota amount are separate axes; don't conflate them. Never read or written directly on User — see Subscription and Effective Plan. (`administrateur` was a fourth value that used to double as the admin-access flag; docs/adr/0015 split that into a separate field, and docs/adr/0017 later retired the value outright once Role took over admin access end to end.)
_Avoid_: Profile — collides with StyleProfile, an unrelated per-CVVersion concept, despite "profile" being the word the product brief uses; Tier, Role — a separate axis from Plan (see Role, Administrator).

**Subscription**:
One User's claim to one Plan for a period — a `startDate`, an optional `endDate` (`null` means it never expires, always true for a `free` Subscription), and, for a `standard`/`premium` Subscription, a `duration` (`monthly` or `yearly`) the `endDate` was computed from. Append-only (docs/adr/0018): assigning a User a new Plan or renewing their current one always creates a new Subscription rather than editing the existing one. Every User gets a `free` Subscription automatically at signup; every other Subscription is created by an Administrator — there is no self-service plan change yet.
_Avoid_: Plan (that's the tier a Subscription grants, not the period itself), Billing, Membership.

**Effective Plan**:
The Plan actually in force for one User right now: their most recent Subscription's Plan if its period covers now, else `free`. Computed live from Subscription on every read — never cached on User, never backfilled by a background job (docs/adr/0018). A lapsed paid Subscription past its `endDate` with no renewal isn't marked expired or replaced by anything until an Administrator acts, so a User's Subscription history can show a gap after their last Subscription (or between two of them) — that gap reads as `free`.
_Avoid_: Current plan, `User.plan` (the retired field this replaces), Active plan.

**Role**:
A User's access tier — `external` | `internal` | `administrator` — orthogonal to Plan/Subscription (see Administrator). `external` is the candidate, and every new User is `external`. `internal` is a support user, not a candidate: what they may do is still to be defined, and the only difference from `external` settled so far is that they aren't offered a choice of CVVersion on a Re-run (see Re-run). Replaces the standalone `isAdmin` boolean (docs/adr/0017).
_Avoid_: `isAdmin` (the retired field), Permission, Tier — Tier is Plan's word, not Role's.

**Administrator**:
A User whose Role is `administrator` (docs/adr/0015, docs/adr/0017) — independent of their Plan/Subscription, so an Administrator keeps a real usage tier while managing the system. The only User who can reach the Web context's Admin area, edit any User's QuotaOverride, edit a Plan's PlanQuotaDefault values, assign another User a new Subscription, block or unblock a User, or change another User's Role. Can't demote their own Role away from `administrator` or block themselves — avoids a lockout with no Administrator left to undo it.
_Avoid_: Admin (fine in prose), Superuser

**Blocked**:
A User whose `blockedAt` is set — every one of their calls into this context is rejected until an Administrator unblocks them (docs/adr/0016). Blocking is purely an access gate: it never suspends their Scouts, touches their data, or changes their Plan/quotas, and is always reversible. An Administrator can't block themselves.
_Avoid_: Suspended (implies automatic or temporary), Disabled, Deactivated, Banned

**CV**:
One candidate CV considered as a whole, independent of any single upload — the full chain of one or more CVVersions linked by `supersededById`, from the first uploaded row through every row a Replace has since produced. Its current version is the one chain member with `supersededById` still `null`; every other member is superseded. A brand-new upload (as opposed to a Replace) starts its own chain, unrelated to any other CV the candidate holds — `label` is not unique, so two chains can coincidentally share one. Deleting a CV (`DELETE /v1/cv-versions/{id}`, called on the chain's current version) removes every CVVersion in the chain in one transaction, and is only permitted when none of them is referenced by an Analysis or an IngestionJob — the two `onDelete: Cascade` foreign keys docs/adr/0005 identified as the reason a lone-row delete was rejected in favor of Replace — mirroring, across the whole chain, the single-row Scout/Application/GeneratedDocument (`onDelete: Restrict`) checks `delete_cv_version` already performed. `isDefault` never blocks a CV's deletion: the system already treats "no default CV" as ordinary (e.g. before a candidate's first "Set default"), so deleting the default CV just returns the account to that same state.
_Avoid_: CVVersion (that's one row in the chain; used loosely as a casual synonym for CV elsewhere in this glossary's prose, but the two are distinct once a chain has more than one row)

**CVVersion**:
One labeled, versioned upload of a candidate's CV (PDF, DOCX, Markdown, or plain text) — one link in a CV's chain. Exactly one per user may be the default; each carries a Markdown rendition and its `conversionStatus`, and — for a PDF/DOCX upload — a StyleProfile and its `styleStatus`. Replacing one never mutates or deletes it — it creates a new CVVersion and sets `supersededById` on the old one (docs/adr/0005), so every Analysis, Application, GeneratedDocument, and Scout that already reference it keep seeing exactly what they always saw. Its Markdown rendition is the one exception: a non-superseded CVVersion can be hand-edited in place by its candidate (docs/adr/0025), which does mutate this same row.
_Avoid_: Resume, CV file

**Markdown rendition**:
The canonical Markdown form of one CVVersion, in `CVVersion.markdownContent` — the exact text the Analysis context's comparison reads. It is the uploaded file itself for a Markdown upload, or the output of the Analysis context's Conversion otherwise. The candidate mostly sees it read-only, except that a non-superseded CVVersion's rendition can also be hand-edited directly by its candidate, which mutates this same field in place — no new CVVersion, no Conversion, no Redaction re-check (docs/adr/0025).
_Avoid_: Parsed CV, CV structured data, preview

**StyleProfile**:
The extracted look-and-feel of one CVVersion, in `CVVersion.styleProfile` — real fonts, RGB colors, and margins read directly from a PDF/DOCX upload, plus a layout archetype (single-column or sidebar-plus-main) and a visual treatment (heading style, sidebar-vs-main region) per SectionType. Derived once, alongside the Markdown rendition, by the Analysis context's Conversion (docs/adr/0008); `CVVersion.styleStatus` tracks that extraction independently of `conversionStatus` — a Markdown/plain-text upload has none, and a failed extraction never fails Conversion or blocks matching, it only means TAILORED_CV rendering falls back to the built-in generic template. Never backfilled for an existing CVVersion; replacing it (docs/adr/0005) is what triggers one.
_Avoid_: Template, design — "template" stays reserved for the existing generic PDF template (`pdf_render.py`); a StyleProfile is what TAILORED_CV rendering consults to deviate from that default.

**SectionType**:
The canonical category one CV section is classified into (SUMMARY, EXPERIENCE, EDUCATION, SKILLS, LANGUAGES, ... OTHER). A StyleProfile records visual style per SectionType, never a section's original literal heading text or position — that's what lets a generated document apply the original's look even when its heading is written in a different language than the source. `CvTailoringAgent` (Analysis context) tags each heading it writes with its SectionType directly, so rendering never re-classifies.
_Avoid_: Section, heading — those name the generic markdown-parsing concept; SectionType is specifically the classification value.

**JobOffer**:
One job posting, deduplicated globally by its source URL — not owned by any single user, since the same posting is relevant to many candidates.
_Avoid_: Job posting, listing — "listing" means something else here, see `IngestionJob`.

**IngestionJob**:
One user-initiated request to discover and process job offers, in one of two modes: a single offer URL, or a preconfigured site plus filters. Carries the CVVersion the discovered offers are to be matched against, and fans out into 1..N linked JobOffers, each of which leads to an Analysis.
_Avoid_: Ingestion request, scrape job, matching run — the run has no aggregate of its own, see Analysis batch.

**SiteConfig**:
The data-driven adapter configuration for one supported job site — selectors or an API endpoint, plus risk and enablement flags — that a site-search `IngestionJob` reads to know how to query that site.
_Avoid_: Site adapter — that's the Ingestion-context code that reads a SiteConfig, not the config row itself.

**Search filter**:
The canonical shape a site-search IngestionJob and a Scout both carry, expressed in this project's own vocabulary and never in any one site's: `keywords`, `location` (free text until a structured picker exists — see [Ingestion](../ingestion/CONTEXT.md)'s Location resolution), `postedWithin` (`24h` | `7d` | `14d` | `30d` | `any`), `contractType` (a list of `CDI` | `CDD` | `INTERIM` | `STAGE` | `ALTERNANCE` | `FREELANCE`), `remote` (`onsite` | `hybrid` | `remote`), and `experienceLevel`. A site's own query vocabulary is reached only by translation, and how faithfully each site can be reached is a FilterSupport — a filter is never quietly dropped on the way.
_Avoid_: Criteria, query — a query is what a Site adapter builds *from* a Search filter; Search parameters — "parameter" is a site's word for its own query string, deliberately not ours.

**FilterSupport**:
How faithfully one site honours one Search filter key: `SUPPORTED` (the candidate gets what they asked for, whether the site filtered it or this pipeline did so afterwards), `APPROXIMATED` (the site shifts relevance or filters on a neighbouring concept, so results outside the filter still come back), or `UNSUPPORTED` (the filter cannot be expressed and is not applied). Declared per (site, filter) pair in `py-db`, beside the Site adapter that honours it, and carried to the candidate by `GET /site-configs` — shown in the Scout form and on the saved Scout, never only alongside the results (docs/adr/0030). Optional per-value derogations cover canonical values a site has no equivalent for, and a derogation always widens the filter rather than narrowing it.
_Avoid_: Site capability — the thing is a pair, not a property of a site: a filter is unsupported "by HelloWork for postedWithin", not "by HelloWork". Ignored filter, `IGNORED` — that names what the site does with the parameter, where all three of these name what the candidate receives.

**Analysis**:
One requested comparison of a JobOffer against a CVVersion, tracked from request through its terminal completed/failed state. Created either by an IngestionJob, in which case it carries its `ingestionJobId`, or directly for an already-extracted JobOffer, in which case it carries none.
_Avoid_: Comparison, report

**Analyses page** (of the list endpoint):
One slice of a candidate's Analyses as `GET /v1/analyses` answers it: `{analyses, total, page, pageSize}`, narrowed by the filters and ordered by the sort the request names (docs/adr/0033). `page` is the page actually *served*, which is not always the one asked for — a request past the end is clamped to the last page rather than answered with nothing, since a `?page=9` outlived by a filter or a deletion is a stale link. Every sort carries a `requestedAt DESC, id` tie-break after the named column, because rows tied on the sort value have no order of their own and an unordered remainder is what makes a paginated list drop and repeat rows between two requests. The `jobOfferId` and `ingestionJobId` scopes skip pagination: each is bounded by its own nature (one JobOffer's analyses, one Analysis batch) and their callers page nothing. The Statut filter's SQL is shared with the Admin analyses table (`api/analysis_filters.py`); what is not shared is how many buckets a caller may name — any number here, exactly one there.
_Avoid_: Batch (that's an Analysis batch, a set sharing one IngestionJob — this is a slice of a query), Cursor/keyset (the pagination is offset-based)

**Re-run** (a.k.a. Retry / "Relancer l'analyse"):
Creating a new, unrelated Analysis for a JobOffer a candidate already analysed — with the same CVVersion by default, or another one they pick, which is what fills the Side-by-side comparison — via the same `POST /v1/analyses` a first-time Analysis uses. Only an `external` User is offered that choice of CVVersion, and only from the Quick view and the Analysis detail page; every other Re-run — an `internal` User's, the bulk action's, the Admin retry's — re-runs the pair as it was, and the `/analyses/new` shortcut already has its own CV picker. Deliberately not a supersede: unlike CVVersion (replace) and GeneratedDocument (regenerate), there is no `supersededById` link back to the Analysis it re-runs from, and the earlier Analysis stays listed in its own right (docs/adr/0011). Four candidate-facing surfaces trigger it: the Analysis detail page's own retry on a `FAILED` Analysis (labelled "Relancer l'analyse" / "Run it again"), the "already analysed" shortcut on `/analyses/new` (labelled "Re-run"), the Quick view's own action on a `COMPLETED` or `FAILED` Analysis, and the Analyses-list bulk-actions bar's own action on the selection (both defined in [Web](../../apps/web/CONTEXT.md)'s context) — all three of the latter reuse the detail page's existing "Relancer l'analyse" copy rather than the `/analyses/new` wording, since that's the copy the product actually asked for here. An Administrator can also re-run from the Admin analyses table (defined in [Web](../../apps/web/CONTEXT.md)'s context, docs/adr/0020) — same pair, owned by the Analysis's own candidate rather than the Administrator. `POST /v1/analyses` itself has no eligibility check of its own (any valid JobOffer/CVVersion pair is accepted regardless of whether another Analysis for it is still running) — Quick view and the bulk-actions bar both restrict to `COMPLETED`/`FAILED` client-side; the bulk action additionally filters its selection down to that eligible subset before firing one `POST v1/analyses` per pair, rather than firing for the whole selection like the bulk status change still does, since a non-terminal Analysis would silently succeed into a redundant, quota-consuming re-run instead of failing like that sibling's ineligible rows do. The bulk document generation filters its selection too now, for a related reason of its own: its ineligible rows *would* fail loudly (a 400 per non-`COMPLETED` row), but a row that already holds that document would succeed into a duplicate nothing displays and the quota still pays for.
_Avoid_: Supersede, Replace, Regenerate (all three deliberately don't apply — see above); Re-analyse (running against another CVVersion is still a Re-run, not a separate action). The product copy itself is inconsistent between "Retry" and "Re-run" for this one action; that's a pre-existing naming split across two screens, not a new distinction to preserve.

**Stuck** (an Analysis):
A non-terminal Analysis nothing is going to advance, because the worker or ElasticMQ restarted and took its queued `analysis-intake` message with it (the local queue is in-memory only). Derived on read, never stored, by `py_db/stuck_analysis.py`'s `is_analysis_stuck` and exposed as `AnalysisResponse.stuck` so the Web reads a boolean instead of re-deriving one. The rule is a plain age check on the row's own clock: non-terminal, and nothing newer than `max(requestedAt, requeuedAt, startedAt)` for `ANALYSIS_STUCK_AFTER_MINUTES` (default 15). The predicate is pure — no session, no query — so `_analysis_response` takes only `now`, passed in so one response judges every row against one clock. It knowingly flags a `PENDING` row that is merely queued behind a Scout's fan-out (25 offers per site, drained one at a time); a `PipelineEvent`-based liveness probe used to spare those, and was withdrawn because the requeue's own events re-armed it for every other stranded row — see docs/adr/0032 for the measurements and for what pays the false positive (`run_crew_task` no-ops on an already-`COMPLETED` Analysis).
_Avoid_: Stale, orphaned, timed out (fine in prose; the field and the term are `stuck`), Failed (a stuck Analysis is deliberately *not* moved to `FAILED` — that would make it terminal and force a quota-charged Re-run)

**Requeue**:
Re-driving one stuck Analysis in place — `POST /v1/analyses/{id}/requeue` puts the same row back to `PENDING` (clearing `errorMessage` and `startedAt`, stamping `requeuedAt`) and re-enqueues it. No new Analysis, and **no quota charged**: the work was already paid for when the row was created, and the interruption was ours. Refused `409 ANALYSIS_ALREADY_TERMINAL` on a `COMPLETED`/`FAILED` Analysis (that is a Re-run, above) and `409 ANALYSIS_NOT_STUCK` when the row turns out to be alive — the endpoint re-checks the Stuck predicate itself rather than trusting the client, which is also what stops a stale screen spending LLM budget. Because `requeuedAt` is the newest term of the staleness clock, stamping it bounds re-clicking to once per stuck window, which is why no quota check is needed. Deliberately not `requestedAt`: that column is the quota clock (`py_db/quota.py` counts by it) and an Admin filter, so moving it would silently spend a daily and a monthly slot. See docs/adr/0032.
_Avoid_: Retry, Re-run, Relaunch (all three are the *other* action — a new row via `POST /v1/analyses`, docs/adr/0011); Resume (the pipeline restarts from the top, it does not continue mid-step)

**Analysis batch**:
The set of Analyses sharing one IngestionJob — every JobOffer that IngestionJob discovered, each matched against the single CVVersion it carries. It has no row of its own: it is exactly the Analyses for one `ingestionJobId`, and is what the multi-offer result view lists, ranked by Match score.
_Avoid_: Match run, matching job — there is deliberately no dedicated entity, see ADR 0002.

**Match score**:
An Analysis result's 0-100 fit rating between a CVVersion and a JobOffer.

**Scout**:
A candidate's saved, self-running search-plus-match configuration — a
label, one base CVVersion, the target SiteConfig keys to search, the same
filter shape an IngestionJob carries, a relevance threshold, and a
lifecycle `status` (`ACTIVE` | `PAUSED` | `ARCHIVED`). Runs once a day while
`ACTIVE`, or on demand via "Run now"; orchestrated by the
[Scout](../scout/CONTEXT.md) context, not by this one.
_Avoid_: Agent — "Agents" is the nav label a candidate sees in
[Web](../../apps/web/CONTEXT.md); `Scout` is the row.

**ScoutRun**:
One execution of a Scout — a real aggregate row, deliberately unlike the
derived Analysis batch above (see docs/adr/0004 for why). Tracks status
(mirroring IngestionJobStatus: `PENDING` | `RUNNING` | `PARTIALLY_COMPLETED`
| `COMPLETED` | `FAILED`) and per-run counts (sites queried, site
unavailable, offers discovered/analysed, relevant finds, documents
generated, and three skip counts: already seen, run-limit, daily-cap). The
anchor `GET /v1/scouts/{id}/stats` and the run-history view query against.
_Avoid_: Match run, Scout job.

**Relevance threshold**:
A Scout's `matchThreshold` (0-100, default 70) — the Match score an Analysis
must meet or exceed to count as a relevant find for that Scout.

**Relevant find**:
A `COMPLETED` Analysis, created by one of a Scout's IngestionJobs, whose
Match score is at or above that Scout's relevance threshold. An Analysis
below the threshold is still visible, as "found — low fit," never
discarded. `Analysis.scoutId` (denormalised, nullable) links it back to its
Scout.
_Avoid_: Match — "match" is the generic comparison result; "relevant find"
specifically means it cleared the threshold.

**GeneratedDocument**:
A generated cover letter (`COVER_LETTER`) or tailored CV (`TAILORED_CV`)
produced from one Analysis — a new row, never a mutation of the base
CVVersion (see docs/adr/0003). Carries its own `markdownContent`,
denormalised `jobOfferId`/`cvVersionId`, an optional `scoutRunId` for
attribution, a `status` (`PENDING` | `GENERATING` | `READY` | `FAILED`),
and a `supersededById` self-link a regenerate sets on the row it replaces.
Produced by the [Analysis](../analysis/CONTEXT.md) context's
GenerationWorkflow, triggered only by an explicit generation request —
never automatically. Each is asked for on its own: `POST
/v1/analyses/{id}/generated-documents` takes an optional `type` and creates
that one row, omitting it creating both, which is what the bulk action and
the Admin table still do (docs/adr/0031). So an Analysis may hold one, both,
or neither, and the call costs whatever it creates against
`DOCUMENTS_DAILY` — the two are not a pair, and the *act* of generating one
has no name of its own beyond producing a GeneratedDocument.
_Avoid_: "Generate documents" as the name of a thing that yields two (it is
the label of the both-at-once action the bulk bar and the Admin table
carry, not a rule about how GeneratedDocuments come into being), Tailored CV file, generated PDF — no PDF or Word file is stored,
only rendered on demand from `markdownContent` (using the base CVVersion's
StyleProfile when the document is a TAILORED_CV with one — docs/adr/0008).

**Application**:
The record of a candidate pursuing one Analysis's offer — user-scoped,
created lazily on the first generation request (of either document) or
"Mark as applied" for that Analysis, and unique per `analysisId`. Carries denormalised
`jobOfferId`/`cvVersionId`/`scoutId` (nullable — a manually-tracked
Analysis has none) and a `status` derived as its latest StatusEvent's
status.
_Avoid_: Job application, tracked offer.

**StatusEvent**:
One append-only entry in an Application's status history — a `status`, an
optional `note`, and an `effectiveDate`. There is no separate "undo"
endpoint; undoing a status change is appending a StatusEvent for the prior
status.
_Avoid_: Status change, audit entry — PipelineEvent (below) is the
unrelated pipeline-observability log; StatusEvent is Application-specific
and user-visible as a timeline.

**PipelineEvent**:
One append-only log row recording a single pipeline stage's start, success, or failure — the one observability trail shared by the Ingestion and Analysis contexts.
_Avoid_: Audit log

**Internal API secret**:
The shared header value that authenticates every call into this context, paired with an `X-User-Id` header this context trusts rather than independently verifying. An accepted MVP boundary, not a signed-request scheme.
_Avoid_: API key

**QuotaKind**:
One of the fixed set of things a Plan limits: active Scouts (concurrent count of `ACTIVE` Scouts, no time window), daily Analyses, monthly Analyses, or daily GeneratedDocuments. Replaces the earlier flat, global caps (`MAX_SCOUTS_PER_USER`, `DAILY_ANALYSIS_CAP`, `DAILY_GENERATION_CAP`) that applied identically to every User regardless of Plan (docs/adr/0014). A fixed enum for now — adding a fifth kind is a code change, not an admin-UI action.
_Avoid_: Agent, active agents — the Web nav label is "Agents," but the counted entity is Scout; this vocabulary never says "agent" for the same reason Scout's own entry doesn't. Resource, metric.

**PlanQuotaDefault**:
The numeric ceiling (or `null` for unlimited) a Plan sets for one QuotaKind, admin-editable without a deploy. `free`'s PlanQuotaDefault briefly went `null` (unlimited) across every QuotaKind as an undocumented side effect of the docs/adr/0018 migration ("Free is free"); docs/adr/0021 reinstated its original #135 seed values (2 active Scouts, 15 daily Analyses, 300 monthly Analyses, 5 daily GeneratedDocuments).
_Avoid_: Default quota, Plan limit

**QuotaOverride**:
A numeric ceiling (or `null`) an Administrator has set for one User on one QuotaKind, taking precedence over that User's Effective Plan's PlanQuotaDefault. Only exists for a User an Administrator has explicitly customized — a User with no QuotaOverride for a given QuotaKind tracks their Effective Plan's default as it changes over time, rather than a value copied at signup (docs/adr/0013).
_Avoid_: User quota, custom limit

**Effective quota**:
The ceiling actually enforced for one User on one QuotaKind: their QuotaOverride if one exists, else their Effective Plan's PlanQuotaDefault. Hard-blocks the corresponding action once reached (create/reactivate for active Scouts, `POST /v1/analyses` for daily/monthly Analyses, document generation for daily GeneratedDocuments) — there is no soft/warn-only mode. Lowering an Effective quota below a User's current active-Scout count never force-pauses their existing Scouts; it only blocks further create/reactivate calls.
_Avoid_: Quota limit, cap (fine in prose; "cap" is also the pre-existing env-var terminology this replaces)

**AdminAuditEvent**:
One append-only entry recording an Administrator's action on a User or on shared config — editing a QuotaOverride, a PlanQuotaDefault, or assigning a User a new Subscription; blocking or unblocking a User; editing a User's name; changing a User's Role; or editing an LLMProviderSetting or the Active LLM provider — actor, target User, field, old/new value, timestamp. A secret Provider parameter is recorded as a set/cleared marker, never its value in any form: this trail is read by more people and kept longer than the row it describes. Renamed from QuotaAuditEvent once its scope grew past quota-only actions (docs/adr/0015). Also covers an Administrator acting on a candidate's own resource from the Admin analyses/scouts/CV versions tables (re-running an Analysis, running/pausing/archiving a Scout, reconverting a CVVersion) via an optional `resourceType`/`resourceId` pair alongside the User-field columns, rather than a second, parallel audit mechanism (docs/adr/0020). A distinct trail from PipelineEvent (pipeline observability) and StatusEvent (an Application's own history): this one exists purely for admin-action provenance.
_Avoid_: QuotaAuditEvent (its old name, now inaccurate — the trail covers non-quota admin actions too), Audit log (ambiguous with PipelineEvent's own "_Avoid_: Audit log" note — this is the admin-provenance trail, not the pipeline one)

**QuotaAlert**:
A persisted notification for one User crossing 80% ("approaching") or 100%+ ("exceeded") of their Effective quota for one QuotaKind — one fixed threshold pair across every QuotaKind for now. Surfaced in the Web context both as a standing notification-feed entry and as an inline banner on the specific action screen at the moment it would be blocked.
_Avoid_: Notification (reserved as the general term should a non-quota use arise later), warning

**LLMProviderSetting**:
The stored configuration for one LLM provider — the Provider parameters an Administrator has filled in, plus whether that provider is the Active LLM provider. Values are held one row each rather than as fixed columns, so a provider carries zero or more of them; which parameters a provider *requires* is never stored (see Provider parameter). Read directly by the [Analysis](../analysis/CONTEXT.md) context, like every other table this context owns.
_Avoid_: LLM provider — that names the Analysis context's provider *interface*, not this row. Provider config, LLM settings.

**Provider parameter**:
One named input a provider needs — `apiKey`, `baseUrl`, `model` — declared in a code-owned catalogue shared by this context and [Analysis](../analysis/CONTEXT.md), not in a table: every parameter name is hardcoded into some provider's constructor, so one no code reads would be a row that does nothing. Each declares whether it is secret and which environment variable it falls back to.
_Avoid_: Env var — a parameter stored in Postgres is no longer an environment variable, even where it carries that variable's meaning. Setting, config key.

**Effective provider parameter**:
The value actually used for one Provider parameter: its LLMProviderSetting value if stored, else that parameter's environment variable, else the provider's hardcoded default (docs/adr/0024). Resolved independently per parameter — one missing field never hands the whole provider back to the environment.
_Avoid_: Resolved value, final value (both fine in prose; this names the resolution specifically, mirroring Effective quota)

**Active LLM provider**:
The one LLMProviderSetting flagged active, or none at all — in which case `LLM_PROVIDER` decides, which is every deployment's starting state and an explicitly selectable choice, not an absence (docs/adr/0024). Activation is refused while any parameter the provider requires has no Effective provider parameter.
_Avoid_: Selected provider, current provider, default provider — "default" belongs to the per-provider hardcoded model/base URL, a different fallback layer.
