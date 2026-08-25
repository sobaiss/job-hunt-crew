// Seeds the 5 SiteConfig rows for PRD Section 8.5's Mode 3 site picker.
// Run via `pnpm prisma db seed` (invoked by prisma migrate dev / directly).
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const siteConfigs = [
  {
    siteKey: "LINKEDIN",
    displayName: "LinkedIn",
    baseUrl: "https://www.linkedin.com",
    searchUrlTemplate:
      "https://www.linkedin.com/jobs/search?keywords={keywords}&location={location}&f_TPR={postedWithin}&f_JT={contractType}&f_WT={remote}",
    filterParamMapping: {
      keywords: "keywords",
      location: "location",
      postedWithin: "f_TPR",
      contractType: "f_JT",
      remote: "f_WT",
    },
    listItemSelector: "ul.jobs-search__results-list > li",
    offerLinkSelector: "a.base-card__full-link",
    offerTitleSelector: "h3.base-search-card__title",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: true,
    antiBotRiskLevel: "HIGH",
    enabled: true,
    notes:
      "Strong anti-bot measures; best-effort HTML scraping per PRD Section 14.",
  },
  {
    siteKey: "INDEED",
    displayName: "Indeed",
    baseUrl: "https://www.indeed.com",
    searchUrlTemplate:
      "https://www.indeed.com/jobs?q={keywords}&l={location}&fromage={postedWithin}&jt={contractType}&remotejob={remote}",
    filterParamMapping: {
      keywords: "q",
      location: "l",
      postedWithin: "fromage",
      contractType: "jt",
      remote: "remotejob",
    },
    listItemSelector: "div.job_seen_beacon",
    offerLinkSelector: "a.jcs-JobTitle",
    offerTitleSelector: "span[title]",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: false,
    antiBotRiskLevel: "MEDIUM",
    enabled: true,
    notes:
      "HTML scraping; best-effort per PRD Section 14, moderate anti-bot risk.",
  },
  {
    siteKey: "FRANCE_TRAVAIL",
    displayName: "France Travail",
    baseUrl: "https://www.francetravail.fr",
    searchUrlTemplate: null,
    filterParamMapping: {
      keywords: "motsCles",
      location: "commune",
      postedWithin: "minCreationDate",
      contractType: "typeContrat",
      remote: "travailATemps",
    },
    listItemSelector: null,
    offerLinkSelector: null,
    offerTitleSelector: null,
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
    },
    listItemSelector: "li[data-testid='search-results-list-item-wrapper']",
    offerLinkSelector: "a[data-testid='job-card-link']",
    offerTitleSelector: "h4",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: true,
    antiBotRiskLevel: "MEDIUM",
    enabled: true,
    notes: "HTML scraping; best-effort per PRD Section 14.",
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
    },
    listItemSelector: "li.react-job-listing",
    offerLinkSelector: "a.jobLink",
    offerTitleSelector: "a.jobLink",
    integrationType: "HTML_SCRAPE",
    apiBaseUrl: null,
    requiresJsRendering: true,
    antiBotRiskLevel: "HIGH",
    enabled: true,
    notes:
      "Strong anti-bot measures; best-effort HTML scraping per PRD Section 14.",
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
