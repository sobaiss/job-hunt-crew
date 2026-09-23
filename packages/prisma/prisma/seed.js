// Seeds the SiteConfig rows for PRD Section 8.5's Mode 3 site picker.
// Run via `pnpm prisma db seed` (invoked by prisma migrate dev / directly).
//
// filterParamMapping maps a generic filter key to that site's own param name.
// Alongside the search filters it carries `id` — the query-string parameter
// that identifies a single offer in that site's URLs — used by the SINGLE_URL
// pipeline (ingestion.site_search.extract_offer_id) to pull an offer id out of
// a pasted URL, not by search-URL building.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const siteConfigs = [
  {
    siteKey: "LINKEDIN",
    displayName: "LinkedIn",
    baseUrl: "https://www.linkedin.com",
    // fr.linkedin.com, not www: LinkedIn locale-routes, and the French host is
    // the one whose *offer* pages carry the JobPosting JSON-LD block that
    // docs/adr/0010's deterministic tier reads instead of paying for an LLM
    // call. www serves the same listing but links on to the same fr.* slugs.
    searchUrlTemplate:
      "https://fr.linkedin.com/jobs/search?keywords={keywords}&location={location}&f_TPR={postedWithin}&f_JT={contractType}&f_WT={remote}",
    filterParamMapping: {
      keywords: "keywords",
      location: "location",
      postedWithin: "f_TPR",
      contractType: "f_JT",
      remote: "f_WT",
      id: "currentJobId",
    },
    listItemSelector: "ul.jobs-search__results-list > li",
    offerLinkSelector: "a.base-card__full-link",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    // Measured false, not assumed: the unauthenticated guest listing is
    // server-rendered. A live fetch of the exact URL this template builds
    // (including the empty f_TPR/f_JT/f_WT params an unfiltered search
    // produces) returned 200 with 59 `a.base-card__full-link` anchors inside
    // `ul.jobs-search__results-list` — both selectors below still match. This
    // was seeded `true` from the start and never verified; leaving it true now
    // means `fetch.fetch_page` would launch Chromium for a page plain HTTP
    // already reads correctly.
    requiresJsRendering: false,
    antiBotRiskLevel: "HIGH",
    enabled: true,
    notes:
      "Guest (unauthenticated) job pages only. Verified reachable over plain " +
      "HTTP with browser headers: listing 200 + 59 matching cards, and offer " +
      "pages carry JobPosting JSON-LD. Two caveats: (1) LinkedIn answers HTTP " +
      "999 on IP reputation / request volume — `blocking.detect_block` reports " +
      "that as ACCESS_DENIED, and per-host pacing (SCRAPER_MIN_DELAY_SECONDS) " +
      "is what keeps it away; a datacenter egress IP is far likelier to see it " +
      "than a residential one. (2) Only the slug URL form " +
      "(/jobs/view/<title>-at-<company>-<id>) serves the full page — the bare " +
      "/jobs/view/<id> form serves an authwall with no JSON-LD, so discovery " +
      "must keep the href the listing gives it rather than rebuild a URL from " +
      "the id. robots.txt disallows /jobs-guest/ and /jobs?runSearch*; " +
      "/jobs/search and /jobs/view are not disallowed. Best-effort per PRD " +
      "Section 14; ToS review still required before production use.",
  },
  {
    siteKey: "INDEED",
    displayName: "Indeed",
    baseUrl: "https://www.indeed.com",
    // fr.indeed.com: the previous www (US) host was also the wrong catalogue
    // for a French candidate. Kept accurate so re-enabling is a one-field
    // change if Indeed's posture ever changes or a partner feed is obtained.
    searchUrlTemplate:
      "https://fr.indeed.com/jobs?q={keywords}&l={location}&fromage={postedWithin}&jt={contractType}&remotejob={remote}",
    filterParamMapping: {
      keywords: "q",
      location: "l",
      postedWithin: "fromage",
      contractType: "jt",
      remote: "remotejob",
      id: "jk",
    },
    listItemSelector: "div.job_seen_beacon",
    offerLinkSelector: "a.jcs-JobTitle",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: false,
    antiBotRiskLevel: "HIGH",
    // Disabled deliberately, not broken. Live check: fr.indeed.com/jobs
    // returns HTTP 403 with "Security Check - Indeed.com" — a Cloudflare
    // CAPTCHA wall — identically for the default python-httpx UA and for full
    // browser headers, so the block is at the TLS-fingerprint / IP-reputation
    // layer, not the header layer. Issue #118 separately confirmed a real
    // headless browser also lands on that captcha, so the browser escalation
    // tier cannot clear it either. Leaving it enabled only produced FAILED
    // IngestionJobs (this database held exactly one, and zero Indeed
    // JobOffers, ever). PRD Section 14's documented fallbacks are official
    // APIs or a scraping-as-a-service provider; the former is now implemented
    // (see the ADZUNA entry below), the latter remains an unexercised option.
    enabled: false,
    notes:
      "DISABLED — Cloudflare CAPTCHA wall (HTTP 403, 'Security Check'). Not a " +
      "selector or header problem: browser headers get the same 403, and a " +
      "headless browser hits the same interactive captcha (#118), so neither " +
      "of this pipeline's tiers can clear it. Use the Adzuna source for " +
      "comparable French coverage. Re-enabling requires either an Indeed " +
      "publisher/partner feed or a commercial unblocking provider, plus the " +
      "ToS review PRD Section 14 defers.",
  },
  {
    siteKey: "FRANCE_TRAVAIL",
    displayName: "France Travail",
    baseUrl: "https://www.francetravail.fr",
    searchUrlTemplate: null,
    // Search is built by the France Travail Site adapter (docs/adr/0029),
    // which reads only `id` from here. `location → commune` and
    // `remote → travailATemps` are gone: the first fed a label to a
    // commune-code parameter, the second named no API parameter at all
    // (#210, py_db.filter_support).
    filterParamMapping: {
      keywords: "motsCles",
      postedWithin: "minCreationDate",
      contractType: "typeContrat",
      id: "id",
    },
    listItemSelector: null,
    offerLinkSelector: null,
    integrationType: "OFFICIAL_API",
    apiBaseUrl: "https://api.francetravail.io/partenaire/offresdemploi/v2",
    requiresJsRendering: false,
    antiBotRiskLevel: "LOW",
    enabled: true,
    notes:
      "Official public API (francetravail.io) per PRD Section 8.5/14 — lower risk, preferred over scraping.",
  },
  {
    siteKey: "WTTJ",
    displayName: "Welcome to the Jungle",
    baseUrl: "https://www.welcometothejungle.com",
    searchUrlTemplate:
      "https://www.welcometothejungle.com/fr/jobs?query={keywords}&refinementList%5Boffices.country_code%5D%5B%5D={location}&refinementList%5Bcontract_type%5D%5B%5D={contractType}&refinementList%5Bremote%5D%5B%5D={remote}",
    filterParamMapping: {
      keywords: "query",
      location: "refinementList[offices.country_code][]",
      postedWithin: "range",
      contractType: "refinementList[contract_type][]",
      remote: "refinementList[remote][]",
      id: "reference",
    },
    listItemSelector: "li[data-testid='search-results-list-item-wrapper']",
    offerLinkSelector: "a[data-testid='job-card-link']",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: true,
    antiBotRiskLevel: "MEDIUM",
    enabled: true,
    notes:
      "Client-rendered, so it goes through the headless-browser tier " +
      "(ingestion.browser_fetch), which was verified to reach the site: the " +
      "page renders (~600kB), the Didomi consent banner is dismissed, and " +
      "blocking.detect_block reports no block — WTTJ's AWS WAF challenge is " +
      "JS-only and the browser clears it (#118). BUT this search still " +
      "discovers zero offers, and the cause is NOT anti-bot: the rendered " +
      "page is WTTJ's jobs *landing* page (only the hero-search and nav " +
      "data-testids are present, no results list). searchUrlTemplate and the " +
      "two selectors below are both stale against WTTJ's current search " +
      "implementation — ?query=&page=, /jobs/search?query=, and the " +
      "refinementList form were all tried and all render the same landing " +
      "page. Fixing this needs a fresh look at how WTTJ's search results are " +
      "requested today (likely its Algolia-backed API), which is site-adapter " +
      "work, not blocking work.",
  },
  {
    siteKey: "GLASSDOOR",
    displayName: "Glassdoor",
    baseUrl: "https://www.glassdoor.com",
    searchUrlTemplate:
      "https://www.glassdoor.com/Job/jobs.htm?sc.keyword={keywords}&locT=C&locKeyword={location}&fromAge={postedWithin}&jobType={contractType}&remoteWorkType={remote}",
    filterParamMapping: {
      keywords: "sc.keyword",
      location: "locKeyword",
      postedWithin: "fromAge",
      contractType: "jobType",
      remote: "remoteWorkType",
      id: "jl",
    },
    listItemSelector: "li.react-job-listing",
    offerLinkSelector: "a.jobLink",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: true,
    antiBotRiskLevel: "HIGH",
    // Disabled for the same reason as Indeed: issue #118's live capture
    // session hit Glassdoor's Cloudflare CAPTCHA challenge through a real
    // headless browser, which is this pipeline's highest tier. Zero Glassdoor
    // JobOffers have ever been ingested.
    enabled: false,
    notes:
      "DISABLED — Cloudflare CAPTCHA challenge, confirmed unreachable even " +
      "through a headless browser (#118). Same posture and same re-enabling " +
      "conditions as INDEED.",
  },
  {
    siteKey: "HELLOWORK",
    displayName: "HelloWork",
    baseUrl: "https://www.hellowork.com",
    searchUrlTemplate:
      "https://www.hellowork.com/fr-fr/emploi/recherche.html?k={keywords}&l={location}&c={contractType}&ray=20&st=relevance&cod=all&msa=0",
    filterParamMapping: {
      keywords: "k",
      location: "l",
      contractType: "c",
    },
    listItemSelector: "[data-cy='serpCard']",
    offerLinkSelector: "a[data-cy='offerTitle']",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: false,
    antiBotRiskLevel: "MEDIUM",
    enabled: true,
    notes:
      "HTML scraping; best-effort per PRD Section 14. hellowork.com's robots.txt " +
      "disallows /fr-fr/emploi/recherche.html (and query-string URLs broadly) — " +
      "scraped anyway as an accepted MVP risk, consistent with the project's " +
      "documented posture for its higher-risk sites. postedWithin and remote " +
      "filters are deliberately unmapped: HelloWork's own vocabulary for those " +
      "facets doesn't match the app's canonical filter values. Pagination beyond " +
      "the first results page is unverified. Live scraping smoke test (#113) " +
      "confirmed listItemSelector/offerLinkSelector match hellowork.com's " +
      "current markup and a discovered offer page scrapes end-to-end; enabled.",
  },
  // --- OFFICIAL_API sources (PRD Section 14's documented alternative to
  // scraping the walled sites). Structured responses, so these skip the
  // scrape + LLM-extraction pipeline entirely, exactly as France Travail
  // does. Adapters: services/ingestion/src/ingestion/api_sources.py
  {
    siteKey: "ADZUNA",
    displayName: "Adzuna",
    baseUrl: "https://www.adzuna.fr",
    searchUrlTemplate: null,
    // Mapped for documentation/admin display; the adapter builds Adzuna's
    // query itself because its contract facets are four independent booleans
    // rather than one parameter, which a flat template can't express.
    filterParamMapping: {
      keywords: "what",
      location: "where",
      postedWithin: "max_days_old",
      contractType: "contract",
      id: "id",
    },
    listItemSelector: null,
    offerLinkSelector: null,
    integrationType: "OFFICIAL_API",
    // Country-scoped root, so switching catalogue is config rather than code.
    apiBaseUrl: "https://api.adzuna.com/v1/api/jobs/fr",
    requiresJsRendering: false,
    antiBotRiskLevel: "LOW",
    // Enabled but inert until credentials exist: the pipeline fails such a job
    // with "enabled but not configured: set ADZUNA_APP_ID, ADZUNA_APP_KEY"
    // rather than a confusing zero-result run.
    enabled: true,
    notes:
      "Official aggregator API — the recommended replacement for the disabled " +
      "INDEED entry: comparable French coverage, structured JSON (no scrape, " +
      "no extraction LLM call), no anti-bot wall. Requires a free key pair " +
      "(ADZUNA_APP_ID / ADZUNA_APP_KEY) from https://developer.adzuna.com/. " +
      "Endpoint verified live: a keyless call returns a well-formed " +
      "{'exception':'AUTH_FAIL'} JSON body, confirming path and params. " +
      "Adzuna has no remote facet, so filters.remote='remote' is folded into " +
      "the keyword query; onsite/hybrid narrow nothing.",
  },
  {
    siteKey: "REMOTIVE",
    displayName: "Remotive",
    baseUrl: "https://remotive.com",
    searchUrlTemplate: null,
    filterParamMapping: {
      keywords: "search",
      id: "id",
    },
    listItemSelector: null,
    offerLinkSelector: null,
    integrationType: "OFFICIAL_API",
    apiBaseUrl: "https://remotive.com/api/remote-jobs",
    requiresJsRendering: false,
    antiBotRiskLevel: "LOW",
    enabled: true,
    notes:
      "Key-free official API, verified live (HTTP 200, structured JSON). " +
      "Remote roles only — every offer is stored with remotePolicy='remote'. " +
      "Its API response carries a legal notice requiring consumers to link " +
      "back to the Remotive URL and credit Remotive as the source: this is " +
      "satisfied by storing that URL as JobOffer.sourceUrl with " +
      "sourceSite=REMOTIVE, so do not canonicalise a Remotive offer to the " +
      "employer's own URL. The API has no location or date parameter; " +
      "postedWithin is applied client-side and location is ignored.",
  },
];

async function main() {
  for (const config of siteConfigs) {
    await prisma.siteConfig.upsert({
      where: { siteKey: config.siteKey },
      create: config,
      update: config,
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
