# Analysis

The CrewAI pipeline that compares one CVVersion against one JobOffer and produces a structured verdict — the agents, the async workflow that sequences them, and the LLM provider abstraction they run on. `CVVersion`, `JobOffer`, and `Analysis` are defined in [API](../api/CONTEXT.md)'s context; this glossary covers the pipeline vocabulary specific to this context.

## Language

**Parsing** (CVVersion):
Turning a CVVersion's uploaded file into its structured data (skills, experience, education) via `CVExtractionAgent`. This context's counterpart to the [Ingestion](../ingestion/CONTEXT.md) context's "extraction" for JobOffers — kept as a distinct term because CVVersion's own status field is literally named `parseStatus`.
_Avoid_: Extraction — reserved for JobOffer's structuring step, owned by the Ingestion context.

**CVExtractionAgent**:
The agent that performs CVVersion parsing.

**JobOfferExtractionAgent**:
The agent that performs JobOffer extraction — called both by this context's own AnalysisWorkflow prerequisites and directly by the Ingestion context's fan-out pipeline.

**ComparisonAnalysisAgent**:
The agent that compares a JobOffer's and CVVersion's structured data and produces the match score, matched/missing skills, and strengths/weaknesses.

**RecommendationWriterAgent**:
The agent that takes ComparisonAnalysisAgent's output and writes the prioritized improvement suggestions and summary.

**AnalysisWorkflow**:
The Step Functions state machine that sequences one Analysis's prerequisites (CVVersion parsed, JobOffer extracted) and the comparison crew run, retrying each step before giving up and marking the Analysis failed.
_Avoid_: Pipeline — too generic; this names the state machine specifically, not the whole system.

**Task token**:
The Step Functions handle a `waitForTaskToken` state hands to the crew run so it can report success or failure asynchronously, without Step Functions holding a Lambda open while the crew works.

**PersistResultLambda**:
The one handler allowed to write an Analysis's terminal result to Postgres, triggered by the S3 write the crew run makes — never the crew run itself.
_Avoid_: Result writer

**LLM provider**:
The swappable interface (Anthropic or OpenAI, chosen by configuration) every agent in this context calls through, so no agent imports an LLM SDK directly.
