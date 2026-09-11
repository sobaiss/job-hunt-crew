"""Scout context: scheduling + run orchestration (issue #54).

`dispatch_scout_run` is the one new seam — modelled on
`ingestion.intake_handler.dispatch_ingestion_job`. It creates one
`SITE_SEARCH` `IngestionJob` per targeted, still-enabled site (each carrying
the Scout's `cvVersionId`, `filters`, and the `scoutRunId`), enqueues them on
the existing `ingestion-intake` queue, and rolls the `ScoutRun` up.
"""
