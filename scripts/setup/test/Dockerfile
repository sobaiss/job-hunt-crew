# The bats runner for scripts/setup (`make test-setup`, CI): bats plus
# openssl, the one tool the setup scripts expect on the host besides Docker.
FROM bats/bats:1.14.0
RUN apk add --no-cache openssl
