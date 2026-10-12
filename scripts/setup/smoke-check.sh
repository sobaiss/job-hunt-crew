#!/usr/bin/env bash
# After `make setup`, from the host: the API answers /healthz, the web app
# answers 200, and the Administrator can sign in with their password (Auth.js
# credentials flow, as the sign-in form does it). CI's install smoke job runs
# it (#261); it needs curl, which `make setup` itself doesn't.
#
# Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... scripts/setup/smoke-check.sh [APP_URL]

set -euo pipefail

app="${1:-http://localhost:3000}"
api="http://localhost:8000"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}" "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"

fail() {
  echo "smoke-check: $1" >&2
  exit 1
}

curl -fsS "$api/healthz" >/dev/null || fail "the API's /healthz didn't answer"
echo "ok   API /healthz"

curl -fsS -o /dev/null "$app/" || fail "the web app didn't answer 200 on /"
echo "ok   web / is 200"

jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
csrf="$(curl -fsS -c "$jar" -b "$jar" "$app/api/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')"
[ -n "$csrf" ] || fail "no CSRF token from $app/api/auth/csrf"
# --data-urlencode with the value read from the environment, via @- stdin, so
# the password never shows on a command line.
location="$(printf '%s' "$ADMIN_PASSWORD" | curl -sS -o /dev/null -w '%{redirect_url}' -c "$jar" -b "$jar" \
  --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$ADMIN_EMAIL" \
  --data-urlencode "password@-" --data-urlencode "callbackUrl=$app/admin" \
  "$app/api/auth/callback/credentials")"
case "$location" in
  *error=*|"") fail "sign-in as $ADMIN_EMAIL failed (redirected to '${location}')" ;;
esac
session="$(curl -fsS -b "$jar" "$app/api/auth/session")"
case "$session" in
  *"\"$ADMIN_EMAIL\""*) ;;
  *) fail "no session for $ADMIN_EMAIL after sign-in: $session" ;;
esac
case "$session" in
  *ADMINISTRATOR*) ;;
  *) fail "$ADMIN_EMAIL signed in, but the session has no ADMINISTRATOR role: $session" ;;
esac
admin_status="$(curl -sS -o /dev/null -w '%{http_code}' -b "$jar" "$app/admin")"
[ "$admin_status" = "200" ] || fail "the Admin area answered $admin_status, not 200"
echo "ok   $ADMIN_EMAIL signs in and reaches the Admin area"
