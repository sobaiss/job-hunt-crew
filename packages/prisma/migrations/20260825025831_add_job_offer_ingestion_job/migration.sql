-- CreateEnum
CREATE TYPE "JobOfferSourceSite" AS ENUM ('LINKEDIN', 'INDEED', 'FRANCE_TRAVAIL', 'WTTJ', 'GLASSDOOR', 'OTHER');

-- CreateEnum
CREATE TYPE "JobOfferExtractionStatus" AS ENUM ('PENDING', 'SCRAPING', 'SCRAPED', 'EXTRACTING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "IngestionMode" AS ENUM ('SINGLE_URL', 'LISTING_URL', 'SITE_SEARCH');

-- CreateEnum
CREATE TYPE "IngestionJobStatus" AS ENUM ('PENDING', 'RUNNING', 'PARTIALLY_COMPLETED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "JobOffer" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceSite" "JobOfferSourceSite" NOT NULL,
    "title" TEXT,
    "company" TEXT,
    "location" TEXT,
    "postedAt" TIMESTAMP(3),
    "rawContentKey" TEXT,
    "structuredData" JSONB,
    "extractionStatus" "JobOfferExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "IngestionMode" NOT NULL,
    "inputUrl" TEXT,
    "siteConfigId" TEXT,
    "filters" JSONB,
    "maxOffers" INTEGER NOT NULL DEFAULT 25,
    "status" "IngestionJobStatus" NOT NULL DEFAULT 'PENDING',
    "discoveredCount" INTEGER NOT NULL DEFAULT 0,
    "scrapedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionJobOffer" (
    "id" TEXT NOT NULL,
    "ingestionJobId" TEXT NOT NULL,
    "jobOfferId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionJobOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobOffer_sourceUrl_key" ON "JobOffer"("sourceUrl");

-- CreateIndex
CREATE INDEX "IngestionJob_userId_idx" ON "IngestionJob"("userId");

-- CreateIndex
CREATE INDEX "IngestionJobOffer_jobOfferId_idx" ON "IngestionJobOffer"("jobOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "IngestionJobOffer_ingestionJobId_jobOfferId_key" ON "IngestionJobOffer"("ingestionJobId", "jobOfferId");

-- AddForeignKey
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionJobOffer" ADD CONSTRAINT "IngestionJobOffer_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionJobOffer" ADD CONSTRAINT "IngestionJobOffer_jobOfferId_fkey" FOREIGN KEY ("jobOfferId") REFERENCES "JobOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
