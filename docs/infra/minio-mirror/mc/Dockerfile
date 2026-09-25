# Rebuild of quay.io/minio/mc — see ../minio/Dockerfile for why this exists,
# and ../README.md for how it's published and refreshed.
FROM alpine:3.20
ARG TARGETARCH
ARG RELEASE=RELEASE.2025-04-08T15-39-49Z

RUN apk add --no-cache ca-certificates curl && \
    curl -fsSL -o /usr/bin/mc \
      "https://github.com/minio/mc/releases/download/${RELEASE}/mc.linux-${TARGETARCH}.${RELEASE}" && \
    curl -fsSL -o /tmp/mc.sha256sum \
      "https://github.com/minio/mc/releases/download/${RELEASE}/mc.linux-${TARGETARCH}.${RELEASE}.sha256sum" && \
    (cd /usr/bin && echo "$(awk '{print $1}' /tmp/mc.sha256sum)  mc" | sha256sum -c -) && \
    chmod +x /usr/bin/mc && \
    rm -f /tmp/mc.sha256sum && \
    apk del curl

ENTRYPOINT ["mc"]
