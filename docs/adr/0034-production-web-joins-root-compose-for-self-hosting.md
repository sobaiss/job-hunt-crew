# A production `web` service joins the root `docker-compose.yml` for self-hosting

job-hunt-crew is open source, and the default installation path is now `git clone` + `make setup` with Docker as the only host prerequisite. That path needs `apps/web` running from the same `docker compose up` as everything else, as a real build (`next build` + `next start`, `standalone` output) rather than the `next dev` loop docs/adr/0026 added. We decided to add that production `web` as a service of the **root** `docker-compose.yml`, included by default in `make up`, reaching `api` over the stack's own network (`http://api:8000`).

This amends docs/adr/0026, it does not reverse it. 0026 kept the dev-mode `web` out of the root compose so that `API_BASE_URL` would mean the same thing in both *dev* modes (`pnpm dev` and `make web-up`, both via the host-published port). That argument is about keeping two dev modes consistent with each other, and it still holds: the dev-mode `web` stays standalone in `apps/web/docker-compose.yml`. A production `web` is a third mode with a different purpose (an installation, not a hot-reload loop), so there is nothing for it to stay consistent with, and making a self-hoster run a second compose file would undo the single-command install.

## Considered options

- **Reuse the dev-mode image for self-hosters** (`make web-up`): nothing new to build, but `next dev` is slow, compiles on first request, and isn't meant for real use.
- **A production image in its own standalone compose file**, true to 0026's letter: rejected, since it brings back the two-command install and the host-port indirection for no benefit in this mode.

## Consequences

`make up` and `pnpm dev` / `make web-up` all bind host port 3000, so a contributor running the dev loop has to stop the stack's `web` first (or start the stack without it). The contributor docs need to say so.
