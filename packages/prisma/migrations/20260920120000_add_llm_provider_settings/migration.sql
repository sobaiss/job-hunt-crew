-- Issue #175 (part of #172, docs/adr/0024): stored LLM provider settings.
-- An LLMProviderSetting is created on the first save or activation -- there
-- are deliberately no seed rows, so "no row" means "environment-driven".

-- CreateEnum
CREATE TYPE "LLMProviderKey" AS ENUM ('ANTHROPIC', 'OPENAI', 'OPENROUTER', 'HUGGINGFACE', 'OLLAMA');

-- CreateTable
CREATE TABLE "LLMProviderSetting" (
    "id" TEXT NOT NULL,
    "providerKey" "LLMProviderKey" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LLMProviderSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LLMProviderSettingValue" (
    "id" TEXT NOT NULL,
    "settingId" TEXT NOT NULL,
    "parameterName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "lastFour" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LLMProviderSettingValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LLMProviderSetting_providerKey_key" ON "LLMProviderSetting"("providerKey");

-- CreateIndex
CREATE UNIQUE INDEX "LLMProviderSettingValue_settingId_parameterName_key" ON "LLMProviderSettingValue"("settingId", "parameterName");

-- AddForeignKey
ALTER TABLE "LLMProviderSettingValue" ADD CONSTRAINT "LLMProviderSettingValue_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "LLMProviderSetting"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: at most one LLMProviderSetting may be active. The activation
-- transaction deactivates the previous active row, and this partial unique
-- index makes the database refuse a second one regardless.
--
-- WARNING for whoever runs `prisma migrate dev`: Prisma cannot express a
-- partial index, so it will report this index as drift and offer to drop it.
-- Do not accept that. This repo only ever runs `prisma migrate deploy`, which
-- does not check for drift.
CREATE UNIQUE INDEX "LLMProviderSetting_single_active_key" ON "LLMProviderSetting"("isActive") WHERE "isActive";
