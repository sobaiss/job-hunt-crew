-- Adzuna and Remotive: OFFICIAL_API job sources added as the documented
-- answer to the sites whose anti-bot walls HTML scraping can't clear
-- (PRD Section 14). Structured offers, so they skip the scrape + LLM
-- extraction pipeline entirely, exactly as France Travail already does.
--
-- Postgres does not allow ALTER TYPE ... ADD VALUE inside a transaction
-- block in older versions; Prisma runs each statement separately, and these
-- are additive, so no data migration is needed.
ALTER TYPE "SiteConfigSiteKey" ADD VALUE IF NOT EXISTS 'ADZUNA';
ALTER TYPE "SiteConfigSiteKey" ADD VALUE IF NOT EXISTS 'REMOTIVE';

ALTER TYPE "JobOfferSourceSite" ADD VALUE IF NOT EXISTS 'ADZUNA';
ALTER TYPE "JobOfferSourceSite" ADD VALUE IF NOT EXISTS 'REMOTIVE';
