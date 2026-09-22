# Dev-loop image for apps/web — the Docker alternative to `pnpm dev` (see
# apps/web/docker-compose.yml and docs/adr/0026-web-docker-dev-mode-standalone.md).
# Not a production build: this runs `next dev`, never `next build`/`next start`.
#
# Built with the repo root as context, mirroring services/api/Dockerfile and
# services/ingestion/Dockerfile, so pnpm can resolve against the workspace's
# root pnpm-lock.yaml/pnpm-workspace.yaml — even though `web` itself has no
# workspace-package dependencies today.
FROM node:22-slim

WORKDIR /app

RUN corepack enable

COPY . .

# --filter web... : only `web` needs installing (it has no workspace-package
# dependencies to pull in), which also skips other workspace members'
# postinstall scripts, e.g. packages/prisma's `prisma generate`.
RUN pnpm install --frozen-lockfile --filter web...

WORKDIR /app/apps/web

EXPOSE 3000

CMD ["pnpm", "dev"]
