# API

The FastAPI service that is the sole owner of Postgres, S3, and SQS for synchronous, user-facing data — CRUD, presigned uploads, SQS enqueue. Reachable only from the [Web](../../apps/web/CONTEXT.md) context's BFF proxy, authenticated by a shared internal secret. Defines the core entities the [Ingestion](../ingestion/CONTEXT.md), [Analysis](../analysis/CONTEXT.md), and [Scout](../scout/CONTEXT.md) contexts read and write directly against the same tables.

## Language

**User**:
The account record for one candidate, identified by email, keyed by the canonical `userId` every other entity here is scoped to.
_Avoid_: Candidate, account — "candidate" names the persona in product conversations; `User` is the row every context actually references.

**Plan**:
A usage tier — `free` | `standard` | `premium` — determining quota defaults (see PlanQuotaDefault) for whichever User holds it through their current Subscription. `free` is unlimited across every QuotaKind. Never read or written directly on User — see Subscription and Effective Plan. (`administrateur` was a fourth value that used to double as the admin-access flag; docs/adr/0015 split that into a separate field, and docs/adr/0017 later retired the value outright once Role took over admin access end to end.)
_Avoid_: Profile — collides with StyleProfile, an unrelated per-CVVersion concept, despite "profile" being the word the product brief uses; Tier, Role — a separate axis from Plan (see Role, Administrator).

**Subscription**:
One User's claim to one Plan for a period — a `startDate`, an optional `endDate` (`null` means it never expires, always true for a `free` Subscription), and, for a `standard`/`premium` Subscription, a `duration` (`monthly` or `yearly`) the `endDate` was computed from. Append-only (docs/adr/0018): assigning a User a new Plan or renewing their current one always creates a new Subscription rather than editing the existing one. Every User gets a `free` Subscription automatically at signup; every other Subscription is created by an Administrator — there is no self-service plan change yet.
_Avoid_: Plan (that's the tier a Subscription grants, not the period itself), Billing, Membership.

**Effective Plan**:
The Plan actually in force for one User right now: their most recent Subscription's Plan if its period covers now, else `free`. Computed live from Subscription on every read — never cached on User, never backfilled by a background job (docs/adr/0018). A lapsed paid Subscription past its `endDate` with no renewal isn't marked expired or replaced by anything until an Administrator acts, so a User's Subscription history can show a gap after their last Subscription (or between two of them) — that gap reads as `free`.
_Avoid_: Current plan, `User.plan` (the retired field this replaces), Active plan.

**Role**:
A User's access tier — `external` | `internal` | `administrator` — orthogonal to Plan/Subscription (see Administrator). Every new User is `external`. `internal` carries no distinct behavior yet; it exists to be assignable ahead of whatever it ends up gating. Replaces the standalone `isAdmin` boolean (docs/adr/0017).
_Avoid_: `isAdmin` (the retired field), Permission, Tier — Tier is Plan's word, not Role's.

**Administrator**:
A User whose Role is `administrator` (docs/adr/0015, docs/adr/0017) — independent of their Plan/Subscription, so an Administrator keeps a real usage tier while managing the system. The only User who can reach the Web context's Admin area, edit any User's QuotaOverride, edit a Plan's PlanQuotaDefault values, assign another User a new Subscription, block or unblock a User, or change another User's Role. Can't demote their own Role away from `administrator` or block themselves — avoids a lockout with no Administrator left to undo it.
_Avoid_: Admin (fine in prose), Superuser

**Blocked**:
A User whose `blockedAt` is set — every one of their calls into this context is rejected until an Administrator unblocks them (docs/adr/0016). Blocking is purely an access gate: it never suspends their Scouts, touches their data, or changes their Plan/quotas, and is always reversible. An Administrator can't block themselves.
_Avoid_: Suspended (implies automatic or temporary), Disabled, Deactivated, Banned

**CVVersion**:
One labeled, versioned upload of a candidate's CV (PDF, DOCX, Markdown, or plain text). Exactly one per user may be the default; each carries a Markdown rendition and its `conversionStatus`, and — for a PDF/DOCX upload — a StyleProfile and its `styleStatus`. Replacing one never mutates or deletes it — it creates a new CVVersion and sets `supersededById` on the old one (docs/adr/0005), so every Analysis, Application, GeneratedDocument, and Scout that already reference it keep seeing exactly what they always saw.
_Avoid_: Resume, CV file

**Markdown rendition**:
The canonical Markdown form of one CVVersion, in `CVVersion.markdownContent` — the exact text the Analysis context's comparison reads. It is the uploaded file itself for a Markdown upload, or the output of the Analysis context's Conversion otherwise; the candidate sees it read-only.
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

**Analysis**:
One requested comparison of a JobOffer against a CVVersion, tracked from request through its terminal completed/failed state. Every Analysis is created by an IngestionJob and carries its `ingestionJobId`.
_Avoid_: Comparison, report

**Re-run** (a.k.a. Retry / "Relancer l'analyse"):
Creating a new, unrelated Analysis for a JobOffer/CVVersion pair a candidate already analysed — via the same `POST /v1/analyses` a first-time Analysis uses. Deliberately not a supersede: unlike CVVersion (replace) and GeneratedDocument (regenerate), there is no `supersededById` link back to the Analysis it re-runs from, and the earlier Analysis stays listed in its own right (docs/adr/0011). Four surfaces trigger it: the Analysis detail page's own retry on a `FAILED` Analysis (labelled "Relancer l'analyse" / "Run it again"), the "already analysed" shortcut on `/analyses/new` (labelled "Re-run"), the Quick view's own action on a `COMPLETED` or `FAILED` Analysis, and the Analyses-list bulk-actions bar's own action on the selection (both defined in [Web](../../apps/web/CONTEXT.md)'s context) — all three of the latter reuse the detail page's existing "Relancer l'analyse" copy rather than the `/analyses/new` wording, since that's the copy the product actually asked for here. `POST /v1/analyses` itself has no eligibility check of its own (any valid JobOffer/CVVersion pair is accepted regardless of whether another Analysis for it is still running) — Quick view and the bulk-actions bar both restrict to `COMPLETED`/`FAILED` client-side; the bulk action additionally filters its selection down to that eligible subset before firing one `POST v1/analyses` per pair, rather than firing for the whole selection like its sibling bulk actions (status change, document generation) do, since a non-terminal Analysis would silently succeed into a redundant, quota-consuming re-run instead of failing like those siblings' ineligible rows do.
_Avoid_: Supersede, Replace, Regenerate (all three deliberately don't apply — see above). The product copy itself is inconsistent between "Retry" and "Re-run" for this one action; that's a pre-existing naming split across two screens, not a new distinction to preserve.

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
GenerationWorkflow, triggered only by an explicit "Generate documents"
action — never automatically.
_Avoid_: Tailored CV file, generated PDF — no PDF or Word file is stored,
only rendered on demand from `markdownContent` (using the base CVVersion's
StyleProfile when the document is a TAILORED_CV with one — docs/adr/0008).

**Application**:
The record of a candidate pursuing one Analysis's offer — user-scoped,
created lazily on the first "Generate documents" or "Mark as applied" for
that Analysis, and unique per `analysisId`. Carries denormalised
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
The numeric ceiling (or `null` for unlimited) a Plan sets for one QuotaKind, admin-editable without a deploy. `free`'s PlanQuotaDefault is `null` (unlimited) across every QuotaKind (docs/adr/0018).
_Avoid_: Default quota, Plan limit

**QuotaOverride**:
A numeric ceiling (or `null`) an Administrator has set for one User on one QuotaKind, taking precedence over that User's Effective Plan's PlanQuotaDefault. Only exists for a User an Administrator has explicitly customized — a User with no QuotaOverride for a given QuotaKind tracks their Effective Plan's default as it changes over time, rather than a value copied at signup (docs/adr/0013).
_Avoid_: User quota, custom limit

**Effective quota**:
The ceiling actually enforced for one User on one QuotaKind: their QuotaOverride if one exists, else their Effective Plan's PlanQuotaDefault. Hard-blocks the corresponding action once reached (create/reactivate for active Scouts, `POST /v1/analyses` for daily/monthly Analyses, document generation for daily GeneratedDocuments) — there is no soft/warn-only mode. Lowering an Effective quota below a User's current active-Scout count never force-pauses their existing Scouts; it only blocks further create/reactivate calls.
_Avoid_: Quota limit, cap (fine in prose; "cap" is also the pre-existing env-var terminology this replaces)

**AdminAuditEvent**:
One append-only entry recording an Administrator's action on a User or on shared config — editing a QuotaOverride, a PlanQuotaDefault, or assigning a User a new Subscription; blocking or unblocking a User; editing a User's name; or changing a User's Role — actor, target User, field, old/new value, timestamp. Renamed from QuotaAuditEvent once its scope grew past quota-only actions (docs/adr/0015). A distinct trail from PipelineEvent (pipeline observability) and StatusEvent (an Application's own history): this one exists purely for admin-action provenance.
_Avoid_: QuotaAuditEvent (its old name, now inaccurate — the trail covers non-quota admin actions too), Audit log (ambiguous with PipelineEvent's own "_Avoid_: Audit log" note — this is the admin-provenance trail, not the pipeline one)

**QuotaAlert**:
A persisted notification for one User crossing 80% ("approaching") or 100%+ ("exceeded") of their Effective quota for one QuotaKind — one fixed threshold pair across every QuotaKind for now. Surfaced in the Web context both as a standing notification-feed entry and as an inline banner on the specific action screen at the moment it would be blocked.
_Avoid_: Notification (reserved as the general term should a non-quota use arise later), warning
