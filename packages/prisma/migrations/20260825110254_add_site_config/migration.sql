-- CreateEnum
CREATE TYPE "SiteConfigSiteKey" AS ENUM ('LINKEDIN', 'INDEED', 'FRANCE_TRAVAIL', 'WTTJ', 'GLASSDOOR');

-- CreateEnum
CREATE TYPE "SiteConfigIntegrationType" AS ENUM ('HTML_SCRAPE', 'OFFICIAL_API');

-- CreateEnum
CREATE TYPE "SiteConfigAntiBotRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "SiteConfig" (
    "id" TEXT NOT NULL,
    "siteKey" "SiteConfigSiteKey" NOT NULL,
    "displayName" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "searchUrlTemplate" TEXT,
    "filterParamMapping" JSONB,
    "listItemSelector" TEXT,
    "offerLinkSelector" TEXT,
    "offerTitleSelector" TEXT,
    "integrationType" "SiteConfigIntegrationType" NOT NULL,
    "apiBaseUrl" TEXT,
    "requiresJsRendering" BOOLEAN NOT NULL DEFAULT false,
    "antiBotRiskLevel" "SiteConfigAntiBotRiskLevel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteConfig_siteKey_key" ON "SiteConfig"("siteKey");
