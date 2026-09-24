-- Requeue a stuck Analysis in place (docs/adr/0032).
--
-- `requeuedAt` records when POST /v1/analyses/{id}/requeue re-drove the row.
-- It is a separate column rather than a rewrite of `requestedAt` because that
-- column is the daily/monthly quota clock (py_db/quota.py counts Analysis rows
-- by requestedAt) and a filter on the admin analyses screen: moving it would
-- silently spend a quota slot on work the user already paid for. It is also
-- the most recent term of the staleness clock, so stamping it restarts that
-- clock and bounds re-clicking to once per stuck window.
--
-- The PipelineEvent index backs the pipeline-liveness probe of the same rule
-- (`max("createdAt")`, py_db/stuck_analysis.py), which runs once per analyses
-- read against the busiest table in the schema.
ALTER TABLE "Analysis" ADD COLUMN "requeuedAt" TIMESTAMP(3);

CREATE INDEX "PipelineEvent_createdAt_idx" ON "PipelineEvent"("createdAt");
