-- Removes SiteConfig.offerTitleSelector: seeded per site but never read by
-- any code path (offer titles come from extraction, per #115), so it was
-- dead configuration. See issue #117.
ALTER TABLE "SiteConfig" DROP COLUMN "offerTitleSelector";
