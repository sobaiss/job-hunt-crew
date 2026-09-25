# MinIO image mirror

`docker-compose.yml`'s `minio` and `minio-createbucket` services used to pull
`quay.io/minio/minio` and `quay.io/minio/mc` directly. Both stopped being
publicly pullable in September 2026: MinIO archived the OSS project (it had
been in maintenance-mode since December 2025) and withdrew its container
images from both Docker Hub and Quay — every tag now 401s, even anonymously
*listing* the quay.io repo requires auth. This broke every CI run and every
fresh local `docker compose up` ([job-hunt-crew CI is red on every
run](../../../.github/workflows/ci.yml) — the "Start Postgres/MinIO/..."
step).

`minio/Dockerfile` and `mc/Dockerfile` in this directory rebuild the exact
same pinned releases from MinIO's own GitHub Release binaries instead —
GitHub's release-asset CDN is a different distribution channel than the
container registries/`dl.min.io`, and is unaffected. Each build downloads the
binary for its target platform plus MinIO's own published `.sha256sum` file
and verifies the download against it before using it. Published as:

- `ghcr.io/sobaiss/job-hunt-crew/minio:RELEASE.2025-04-08T15-41-24Z`
- `ghcr.io/sobaiss/job-hunt-crew/minio-mc:RELEASE.2025-04-08T15-39-49Z`

Both are multi-arch (`linux/amd64` + `linux/arm64`), so they run unchanged on
GitHub Actions' amd64 runners and on Apple Silicon dev machines. Both are set
**public** on GHCR (Settings → Danger Zone → Change visibility) so CI and
local dev can pull them anonymously, same as MinIO's own images used to be —
GitHub's Packages REST API has no endpoint to flip this from a script, only
`GET`/`DELETE`/restore, so this is a manual step every time a new tag is
published.

## Rebuilding for a newer MinIO/mc release

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg RELEASE=RELEASE.<new-tag> \
  --build-arg MC_RELEASE=RELEASE.<matching-mc-tag> \
  -t ghcr.io/sobaiss/job-hunt-crew/minio:RELEASE.<new-tag> \
  --push \
  docs/infra/minio-mirror/minio

docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg RELEASE=RELEASE.<matching-mc-tag> \
  -t ghcr.io/sobaiss/job-hunt-crew/minio-mc:RELEASE.<matching-mc-tag> \
  --push \
  docs/infra/minio-mirror/mc
```

Then:

1. Update the two `image:` tags in `docker-compose.yml`.
2. Open the new version on
   https://github.com/users/sobaiss/packages/container/package/job-hunt-crew%2Fminio
   and https://github.com/users/sobaiss/packages/container/package/job-hunt-crew%2Fminio-mc
   and set it public (new pushes default to inheriting the package's
   visibility, which should already be public from the first publish — but
   double check, since GHCR has occasionally reset this on some accounts).

If MinIO stops publishing GitHub Release binaries too, or the project's
license terms change in a way that makes rebuilding not viable, see the
alternatives evaluated in the discussion that led here: SeaweedFS and
S3Proxy are the maintained, Apache-2.0, drop-in S3-compatible options most
projects are migrating to.
