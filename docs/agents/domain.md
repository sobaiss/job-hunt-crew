# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: one `CONTEXT.md` per app/service, not a single repo-wide one.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** at the repo root: system-wide decisions. Also check the relevant context's own `docs/adr/` (below) for context-scoped decisions.

If any of these files don't exist yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Contexts follow this repo's existing `apps/*` / `services/*` layout — no generic `src/<context>/` convention here:

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
├── apps/
│   └── web/
│       ├── CONTEXT.md                 ← Next.js UI + BFF proxy context
│       └── docs/adr/                  ← context-specific decisions
└── services/
    ├── api/
    │   ├── CONTEXT.md                 ← FastAPI backend context (sole DB/S3/SQS owner)
    │   └── docs/adr/
    ├── ingestion/
    │   ├── CONTEXT.md                 ← scraping / offer ingestion context
    │   └── docs/adr/
    └── analysis/
        ├── CONTEXT.md                 ← CrewAI analysis pipeline context
        └── docs/adr/
```

`packages/prisma` (schema/migrations) and `packages/py-db` (generated SQLAlchemy models) are shared support packages, not independent domain contexts — they don't get their own `CONTEXT.md`. Terminology for the data model they carry belongs in whichever service's `CONTEXT.md` owns that part of the domain (mainly `services/api`).

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant context's `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR (system-wide or context-scoped), surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
