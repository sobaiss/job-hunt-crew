# Ingestion

Turns a candidate's ingestion request into scraped, structured JobOffers, then starts one Analysis per offer — the scrape/listing/site-adapter pipeline behind an `IngestionJob`'s two modes (a single offer URL, or a preconfigured site plus filters). Reads and writes the same Postgres tables and S3 buckets as [API](../api/CONTEXT.md) directly, independent of API's HTTP surface. Entities referenced below (`JobOffer`, `IngestionJob`, `SiteConfig`) are defined in API's context; this glossary covers only the process vocabulary specific to this context.

## Language

**Scrape**:
Fetching one JobOffer's raw HTML by its source URL and storing it in S3, ahead of extraction. Moves a JobOffer from pending to scraped, or to failed on fetch error.
_Avoid_: Fetch — fetch is the HTTP call; scrape is the whole stage, including the S3 write and status transition.

**Block**:
An anti-bot interstitial served in place of the content — a JS challenge, a CAPTCHA wall, a sign-in wall, a rate-limit or a reputation denial. Classified by `blocking.detect_block`, which returns a `BlockKind` plus the one property the pipeline acts on: whether a headless browser could plausibly get past it. A block is never stored as a scrape, and always surfaces as a `BLOCKED_<KIND>:` `errorMessage`.
_Avoid_: Selector drift — drift is the opposite diagnosis (real content, stale selectors), and the two used to be conflated in a single hedged error message.

**Escalation ladder**:
The three rungs `fetch.fetch_page` climbs for one URL: plain HTTP through the hardened shared client, then a headless browser (entered when the site is client-rendered or when the block is browser-solvable), then stop and report the reason. A CAPTCHA wall skips the browser rung entirely — escalating into it is latency with no chance of success.

**API source**:
A job source that returns structured offers over an official API instead of HTML (`SiteConfig.integrationType = OFFICIAL_API`). Skips scrape *and* extraction: offers go straight to `READY` with `structuredData` filled, so no LLM extraction call is spent and no anti-bot system is involved. France Travail keeps its own module for its OAuth2 flow and per-offer endpoint; every other source is an adapter in `api_sources.SOURCES` mapping that API's JSON onto a `NormalisedOffer`, over the shared lifecycle in `api_ingest.link_api_offers`.
_Avoid_: Site adapter — a site adapter reads a SiteConfig's CSS selectors out of HTML; an API source never touches HTML.

**Extraction** (JobOffer):
Turning a JobOffer's raw scraped HTML into its structured data (title, company, location, postedAt, description, requirements, salary, contract type, remote policy, seniority) via the Analysis context's `JobOfferExtractionAgent`. A missing title means extraction failed — every other field may legitimately come back empty (docs/adr/0010).
_Avoid_: Parsing — parsing is CVVersion's term, owned by the Analysis context.

**Listing fetch**:
Following a search-results page's "next page" links, capped at a page limit, to gather every listing page's raw HTML ahead of offer discovery.

**Offer discovery**:
Pulling individual offer URLs out of one or more listing pages — either via a SiteConfig's selectors (accurate, per-site) or a generic "repeated card" heuristic (a lower-accuracy fallback for sites with no matching SiteConfig).
_Avoid_: Offer extraction — extraction (above) is a distinct, later stage: structuring the content of one already-scraped offer, not finding its URL.

**Site adapter**:
The code that reads one SiteConfig row's selectors or template to build a search URL, or to pull offer links out of that specific site's HTML shape.
_Avoid_: SiteConfig — the config row itself, owned by the API context.

**Dedupe-and-cap**:
Deduplicating discovered offer URLs and truncating the list to an IngestionJob's max-offers limit, before any of them are linked or scraped.

**Fan-out**:
Linking each retained discovered URL to a globally-deduplicated JobOffer, running scrape + extraction for each in turn, starting an Analysis for each offer that reaches a ready state, then rolling up the parent IngestionJob's aggregate counts and status from the results.
