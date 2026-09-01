# Built with the repo root as build context (pnpm workspace: packages/prisma
# is resolved against the shared root pnpm-lock.yaml). Applies migrations
# (`prisma migrate deploy`) against the docker-compose Postgres on startup —
# see the `migrate` service in docker-compose.yml. Not used for anything
# beyond that (no client generation, no seeding).
FROM node:22-alpine

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile --filter @job-hunt-crew/prisma... --ignore-scripts

WORKDIR /app/packages/prisma

CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
