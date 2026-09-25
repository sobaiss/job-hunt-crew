# Rebuild of quay.io/minio/minio, whose upstream image (and the dl.min.io CDN
# the official Dockerfile.release downloads from) is no longer publicly
# pullable: MinIO archived the OSS project and withdrew its container images
# in September 2026, and even anonymously *listing* the quay.io repo now
# requires auth. This rebuilds the exact same release from MinIO's own GitHub
# Release binaries instead (GitHub's release-asset CDN is unaffected),
# sha256-verified against MinIO's own published .sha256sum files. See
# ../README.md for how this is published and how to refresh it.
#
# Also bundles `mc`, same as MinIO's own image did — docker-compose.yml's
# healthcheck runs `mc ready local` *inside* this container.
FROM alpine:3.20
ARG TARGETARCH
ARG RELEASE=RELEASE.2025-04-08T15-41-24Z
ARG MC_RELEASE=RELEASE.2025-04-08T15-39-49Z

RUN apk add --no-cache ca-certificates curl && \
    curl -fsSL -o /usr/bin/minio \
      "https://github.com/minio/minio/releases/download/${RELEASE}/minio.linux-${TARGETARCH}.${RELEASE}" && \
    curl -fsSL -o /tmp/minio.sha256sum \
      "https://github.com/minio/minio/releases/download/${RELEASE}/minio.linux-${TARGETARCH}.${RELEASE}.sha256sum" && \
    (cd /usr/bin && echo "$(awk '{print $1}' /tmp/minio.sha256sum)  minio" | sha256sum -c -) && \
    curl -fsSL -o /usr/bin/mc \
      "https://github.com/minio/mc/releases/download/${MC_RELEASE}/mc.linux-${TARGETARCH}.${MC_RELEASE}" && \
    curl -fsSL -o /tmp/mc.sha256sum \
      "https://github.com/minio/mc/releases/download/${MC_RELEASE}/mc.linux-${TARGETARCH}.${MC_RELEASE}.sha256sum" && \
    (cd /usr/bin && echo "$(awk '{print $1}' /tmp/mc.sha256sum)  mc" | sha256sum -c -) && \
    chmod +x /usr/bin/minio /usr/bin/mc && \
    rm -f /tmp/minio.sha256sum /tmp/mc.sha256sum && \
    apk del curl

COPY docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
RUN chmod +x /usr/bin/docker-entrypoint.sh

EXPOSE 9000 9001
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
