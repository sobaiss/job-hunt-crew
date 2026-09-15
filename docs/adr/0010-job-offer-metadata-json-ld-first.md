# JobOffer title/company/location/postedAt come from embedded JobPosting JSON-LD first, LLM extraction second

`JobOffer.title`/`company`/`location`/`postedAt` have existed on the model since day one, but no HTML_SCRAPE site (LinkedIn, Indeed, WTTJ, Glassdoor, HelloWork) has ever populated them — only France-Travail's `OFFICIAL_API` path sets them, from its own API response. `JobOfferExtractionAgent`'s schema never asked its LLM for these fields, and `SiteConfig.offerTitleSelector` — a per-site selector clearly intended for this — was never wired into any discovery or extraction code. HelloWork simply surfaced a gap every scraped site already had.

Fixing this by extending `JobOfferExtractionAgent`'s prompt to also infer these fields turned out to be the wrong default: a real HelloWork offer page was fetched and inspected, and its `<head>` carries a complete `schema.org`/`JobPosting` `<script type="application/ld+json">` block — `title`, `hiringOrganization.name`, `jobLocation` (structured address), `datePosted` (ISO 8601), plus `baseSalary` and `employmentType` for free. This is the markup Google for Jobs requires, so most job boards already emit it for SEO.

**Decision**: `extract_job_offer` first searches the full, untruncated raw HTML for a `JobPosting` JSON-LD block and reads title/company/location/postedAt (and salary/employmentType) from it directly when present — deterministic parsing, no LLM call, no per-site code. Only when no such block exists does it fall back to `JobOfferExtractionAgent`'s LLM schema, extended to also ask for these fields. `MAX_HTML_CHARS` truncation (and a script/style strip) now applies only to whatever is left for that LLM fallback, never to the search for JSON-LD — the same real page already showed the existing 20k-char cutoff landing inside the JSON-LD block itself and past almost the entire real `<body>`, so this reordering also fixes a latent quality issue in the fields extraction already shipped for (description, salary, etc.).

A missing title after both tiers now flips `extractionStatus` to `FAILED` rather than `READY` with `title=null`: a real job posting essentially always has one, so its absence is a stronger signal of a broken scrape (block page, wrong content, dead selector) than a legitimately missing field. Company/location/postedAt stay nullable on a `READY` offer — a source page can legitimately omit them (anonymous "confidential" postings, no stated date).

## Considered options

- **LLM-only** (just extend the schema, keep one path): rejected — asks a probabilistic model to infer data the source already publishes in a structured, standard format, and does nothing about the truncation bug already clipping that data.
- **Per-site CSS selectors** (wire up `offerTitleSelector`, add equivalents for company/location/date): rejected — reintroduces the per-site fragility the pipeline had already moved away from for every other structured field (description, salary, contract type, ...), for data that's available generically via JSON-LD on most sites anyway.

## Consequences

- `title` is a de facto required field, enforced via `extractionStatus`, not a DB constraint — the column stays nullable; France-Travail's own path is untouched and remains authoritative for its offers.
- `SiteConfig.offerTitleSelector` and its seed data are removed as dead config now that no code path needs it.
- Offers already scraped before this change get repaired by a one-off re-extraction script reading already-stored S3 raw HTML — no re-scrape needed.
