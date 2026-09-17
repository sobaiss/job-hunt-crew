# API

The FastAPI service that is the sole owner of Postgres, S3, and SQS for synchronous, user-facing data — CRUD, presigned uploads, SQS enqueue. Reachable only from the [Web](../../apps/web/CONTEXT.md) context's BFF proxy, authenticated by a shared internal secret. Defines the core entities the [Ingestion](../ingestion/CONTEXT.md), [Analysis](../analysis/CONTEXT.md), and [Scout](../scout/CONTEXT.md) contexts read and write directly against the same tables.

## Language

**User**:
The account record for one candidate, identified by email, keyed by the canonical `userId` every other entity here is scoped to.
_Avoid_: Candidate, account — "candidate" names the persona in product conversations; `User` is the row every context actually references.

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
