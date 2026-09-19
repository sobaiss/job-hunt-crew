# Analysis

The CrewAI pipeline that compares one CVVersion against one JobOffer and produces a structured verdict — the agents, the async workflow that sequences them, and the LLM provider abstraction they run on. It also owns document generation: turning one relevant find into a cover letter and a tailored CV. `CVVersion`, `JobOffer`, `Analysis`, and `GeneratedDocument` are defined in [API](../api/CONTEXT.md)'s context; this glossary covers the pipeline vocabulary specific to this context.

## Language

**Conversion** (CVVersion):
Turning a CVVersion's uploaded file into its Markdown rendition (defined in [API](../api/CONTEXT.md)'s context) — mechanical text extraction followed by one LLM normalisation pass, skipped entirely when the upload is already Markdown or plain text. Redaction (below) always runs regardless of format. For a PDF/DOCX upload, Conversion also derives a StyleProfile (defined in [API](../api/CONTEXT.md)'s context) in the same pass — deterministic font/color/margin extraction plus one LLM call for layout archetype and per-SectionType classification — tracked by its own `styleStatus`, independent of `conversionStatus`: a StyleProfile failure never fails the Markdown rendition or blocks matching (docs/adr/0008). AnalysisWorkflow's `EnsureCVConverted` step runs it as a comparison prerequisite; the API context's manual "convert" action runs the same code off an SQS message.
_Avoid_: Parsing — the CV path no longer produces structured data. Extraction — reserved for JobOffer's structuring step, owned by the Ingestion context.

**Redaction** (CVVersion):
The step, always part of Conversion regardless of upload format, that strips the candidate's own identifying data — name, email, phone, postal address, date of birth/age, nationality, marital status, gender — and any third-party reference's contact details out of the Markdown rendition before it is saved, so no identity data reaches matching, the candidate's read-only preview, or generation (docs/adr/0022). For PDF/DOCX, its instructions are folded into the existing normalisation pass; for a Markdown/plain-text upload (which otherwise gets no LLM call at all) it runs as its own minimal-diff pass — remove only the flagged categories, reproduce everything else verbatim, deliberately not the reformatting a PDF/DOCX upload gets. A deterministic regex/exact-match check for email, phone, and the account's own `User.name`/`User.email` follows either path as a safety net; a hit there, or any Redaction LLM failure, fails Conversion outright — no unredacted fallback, no separate status field. Deliberately kept: city/country of residence or desired location, employer/school names, job titles, dates, skills, certifications, languages, project descriptions, and URLs — all still useful for matching. Because the base CVVersion's Markdown rendition loses identity data, CoverLetterWriterAgent/CvTailoringAgent (below) never write it back in; the generation pipeline injects `User.name`/`User.email` into a GeneratedDocument's `markdownContent` afterward instead.
_Avoid_: Anonymization, PII scrubbing — Redaction is the chosen term. Sanitization — too generic, reads as input validation.

**JobOfferExtractionAgent**:
The agent that performs JobOffer extraction — called both by this context's own AnalysisWorkflow prerequisites and directly by the Ingestion context's fan-out pipeline.

**ComparisonAnalysisAgent**:
The agent that compares a JobOffer's structured data against a CVVersion's Markdown rendition and produces the match score, matched/missing skills, and strengths/weaknesses.

**RecommendationWriterAgent**:
The agent that takes ComparisonAnalysisAgent's output and writes the prioritized improvement suggestions and summary.

**AnalysisWorkflow**:
The Step Functions state machine that sequences one Analysis's prerequisites (CVVersion converted, JobOffer extracted) and the comparison crew run, retrying each step before giving up and marking the Analysis failed. `local_pipeline` is the dev-only in-process equivalent: the same steps in the same order, chained directly with no Step Functions, so the local `worker` can drain `analysis-intake` off `docker compose up` alone — the same shape Conversion's SQS handler already has.
_Avoid_: Pipeline — too generic; this names the state machine specifically, not the whole system.

**Task token**:
The Step Functions handle a `waitForTaskToken` state hands to the crew run so it can report success or failure asynchronously, without Step Functions holding a Lambda open while the crew works.

**PersistResultLambda**:
The one handler allowed to write an Analysis's terminal result to Postgres, triggered by the S3 write the crew run makes — never the crew run itself.
_Avoid_: Result writer

**LLM provider**:
The swappable interface every agent in this context calls through, so no agent imports an LLM SDK directly. Chosen by configuration: Anthropic or OpenAI (hosted, API key required — the only options supported in production) or a local Ollama runtime (no key, dev-local only).

**GenerationWorkflow**:
The workflow that turns one Analysis into its GeneratedDocument rows —
deliberately separate from AnalysisWorkflow (docs/adr/0004), with its own
`generation-intake` queue, triggered only by an explicit "Generate
documents" action, never automatically when an Analysis completes.
`run_generation_pipeline` (`generation_pipeline.py`) is the dev-only
in-process equivalent `local_pipeline` already established for
AnalysisWorkflow: the same steps in the same order, chained directly with
no Step Functions.
_Avoid_: Document pipeline — this names the workflow specifically,
mirroring how AnalysisWorkflow is named rather than "the pipeline."

**CoverLetterWriterAgent** / **CvTailoringAgent**:
The two agents that produce a GeneratedDocument's `markdownContent` —
prose Markdown, not JSON, unlike ComparisonAnalysisAgent and
RecommendationWriterAgent. Each takes the base CVVersion's Markdown
rendition, the JobOffer's structured data, and the Analysis's matched/
missing-skill lists as input, and is bound by the truthfulness constraint
(docs/adr/0003): reorder, re-emphasise, and re-word only what the base CV
already contains, never fabricate employers, dates, titles, or
credentials. Output language follows the offer's detected language, falling
back to the candidate's Locale (defined in [Web](../../apps/web/CONTEXT.md)'s
context). CvTailoringAgent additionally tags each heading it writes with its
SectionType (docs/adr/0008), so TAILORED_CV rendering can apply the base
CVVersion's StyleProfile — per SectionType, never the original's section
order, which the truthfulness constraint's reordering already governs —
without a second classification pass. CoverLetterWriterAgent's output
carries no such tag: a cover letter is never rendered against a
StyleProfile. Neither agent's own output carries the candidate's name or
contact details, since Redaction (above) has already stripped those from
the base CVVersion's Markdown rendition it reads; the generation pipeline
appends `User.name`/`User.email` to `GeneratedDocument.markdownContent`
afterward, outside the LLM call, so the stored document — and every
preview or render taken from it — stays consistent (docs/adr/0022).
_Avoid_: CV rewriter — the output is a new GeneratedDocument, never a
rewrite of the CVVersion itself.
