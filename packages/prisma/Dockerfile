# Built with the repo root as build context (pnpm workspace: packages/prisma
# is resolved against the shared root pnpm-lock.yaml). The `migrate` service
# in docker-compose.yml (`tools` profile): its default command applies the
# migrations (`prisma migrate deploy`); `make setup` also runs the seed in it
# (`pnpm exec prisma db seed`), hence the generated client.
FROM node:22-alpine

# Prisma's engines link against OpenSSL.
RUN apk add --no-cache openssl && corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile --filter @job-hunt-crew/prisma... --ignore-scripts

WORKDIR /app/packages/prisma

RUN pnpm exec prisma generate

CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
