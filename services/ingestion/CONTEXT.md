# Ingestion

Turns a candidate's ingestion request into scraped, structured JobOffers, then starts one Analysis per offer — the scrape/listing/site-adapter pipeline behind an `IngestionJob`'s two modes (a single offer URL, or a preconfigured site plus filters). Reads and writes the same Postgres tables and S3 buckets as [API](../api/CONTEXT.md) directly, independent of API's HTTP surface. Entities referenced below (`JobOffer`, `IngestionJob`, `SiteConfig`) are defined in API's context; this glossary covers only the process vocabulary specific to this context.

## Language

**Scrape**:
Fetching one JobOffer's raw HTML by its source URL and storing it in S3, ahead of extraction. Moves a JobOffer from pending to scraped, or to failed on fetch error.
_Avoid_: Fetch — fetch is the HTTP call; scrape is the whole stage, including the S3 write and status transition.

**Extraction** (JobOffer):
Turning a JobOffer's raw scraped HTML into its structured data (description, requirements, salary, contract type, remote policy, seniority) via the Analysis context's `JobOfferExtractionAgent`.
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
