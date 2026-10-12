#!/usr/bin/env bats
# Tests for scripts/setup/setup.sh, the `make setup` orchestrator (#261).
# Docker and make are stubs (test/stubs/docker logs every call), so these
# check what the orchestrator asks Docker to do and in which order, and what
# it tells the user; the real stack is exercised by CI's install smoke job.
# Run with `make test-setup`.

SETUP="$BATS_TEST_DIRNAME/../setup.sh"

setup() {
  ROOT="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$ROOT/scripts/setup"
  cp "$BATS_TEST_DIRNAME/../env-merge.sh" "$ROOT/scripts/setup/"
  cat >"$ROOT/.env.example" <<'EOF'
AUTH_SECRET=""
INTERNAL_API_SECRET=""
SETTINGS_ENCRYPTION_KEY=""
# LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=""
OPENAI_API_KEY=""
OPENROUTER_API_KEY=""
OLLAMA_BASE_URL=""
# APP_URL="http://localhost:3000"
EMAIL_SERVER=""
# EMAIL_FROM="Job Hunt Crew <no-reply@job-hunt-crew.local>"
AUTH_GOOGLE_ID=""
AUTH_GOOGLE_SECRET=""
AUTH_LINKEDIN_ID=""
AUTH_LINKEDIN_SECRET=""
FRANCE_TRAVAIL_CLIENT_ID=""
FRANCE_TRAVAIL_CLIENT_SECRET=""
ADZUNA_APP_ID=""
ADZUNA_APP_KEY=""
EOF
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  cp "$BATS_TEST_DIRNAME/stubs/docker" "$BIN/docker"
  printf '#!/bin/sh\n' >"$BIN/make"
  chmod +x "$BIN/docker" "$BIN/make"
  export PATH="$BIN:$PATH"
  export DOCKER_LOG="$BATS_TEST_TMPDIR/docker.log"
  : >"$DOCKER_LOG"
  export SETUP_NONINTERACTIVE=1
  export ADMIN_EMAIL="admin@example.org" ADMIN_NAME="Ada Admin" ADMIN_PASSWORD="s3cret-Passw0rd"
  export SETUP_HEALTH_TIMEOUT=2 SETUP_HEALTH_INTERVAL=0
  unset LLM_PROVIDER ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY OLLAMA_BASE_URL
  unset APP_URL EMAIL_SERVER EMAIL_FROM AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET \
    AUTH_LINKEDIN_ID AUTH_LINKEDIN_SECRET FRANCE_TRAVAIL_CLIENT_ID \
    FRANCE_TRAVAIL_CLIENT_SECRET ADZUNA_APP_ID ADZUNA_APP_KEY
}

# Sets every optional integration in the environment (non-interactive input).
export_all_integrations() {
  export APP_URL="https://jobs.example.org"
  export EMAIL_SERVER="smtp://mailer:smtp-pass-123@smtp.example.org:587"
  export EMAIL_FROM="Jobs <jobs@example.org>"
  export AUTH_GOOGLE_ID="google-id" AUTH_GOOGLE_SECRET="google-secret-123"
  export AUTH_LINKEDIN_ID="linkedin-id" AUTH_LINKEDIN_SECRET="linkedin-secret-123"
  export FRANCE_TRAVAIL_CLIENT_ID="ft-id" FRANCE_TRAVAIL_CLIENT_SECRET="ft-secret-123"
  export ADZUNA_APP_ID="adzuna-id" ADZUNA_APP_KEY="adzuna-key-123"
}

teardown() {
  [ -z "${LISTENER:-}" ] || kill "$LISTENER" 2>/dev/null || true
}

run_setup() {
  run "$SETUP" --root "$ROOT" "$@"
}

# The line number of the first docker call matching a pattern (0 if none).
call_line() {
  grep -n -- "$1" "$DOCKER_LOG" | head -1 | cut -d: -f1 || true
}

assert_nothing_started() {
  ! grep -Eq 'compose.* (up|build|run)( |$)' "$DOCKER_LOG"
}

# --- Prerequisites -----------------------------------------------------------

@test "no docker: fails naming Docker, starts nothing" {
  rm "$BIN/docker"
  PATH="$BIN:/usr/bin:/bin" run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"Docker is not installed"* ]]
  [ ! -f "$ROOT/.env" ]
}

@test "docker daemon not running: fails saying so" {
  STUB_INFO_EXIT=1 run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"Docker daemon"* ]]
  assert_nothing_started
}

@test "no Docker Compose v2: fails naming it" {
  STUB_COMPOSE_VERSION_EXIT=1 run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"Docker Compose v2"* ]]
  assert_nothing_started
}

@test "no make: fails naming it" {
  rm "$BIN/make"
  # make isn't in the test image, so dropping the stub removes it.
  ! command -v make || skip "make is installed in this image"
  run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"make"* ]]
  assert_nothing_started
}

@test "a port held by another program: fails naming the port, starts nothing" {
  nc -lk -p 9324 >/dev/null 2>&1 &
  LISTENER=$!
  sleep 0.3
  run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"9324"* ]]
  [[ "$output" == *"elasticmq"* ]]
  assert_nothing_started
  [ ! -f "$ROOT/.env" ]
}

@test "a port held by this stack is not a conflict (re-run)" {
  nc -lk -p 9324 >/dev/null 2>&1 &
  LISTENER=$!
  sleep 0.3
  STUB_PS_OUT=abc123 run_setup
  [ "$status" -eq 0 ]
  grep -q "label=com.docker.compose.project.working_dir=$ROOT" "$DOCKER_LOG"
}

# --- Administrator inputs ------------------------------------------------------

@test "non-interactive fresh install without ADMIN_*: fails naming them, starts nothing" {
  unset ADMIN_NAME ADMIN_PASSWORD
  run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"ADMIN_NAME"* ]]
  [[ "$output" == *"ADMIN_PASSWORD"* ]]
  [[ "$output" != *"ADMIN_EMAIL,"* ]]
  assert_nothing_started
}

@test "non-interactive: a password under 8 characters is refused before anything starts" {
  ADMIN_PASSWORD=short run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"at least 8"* ]]
  assert_nothing_started
}

@test "the Administrator's inputs never reach .env, a command line or the output" {
  run_setup
  [ "$status" -eq 0 ]
  ! grep -q "s3cret-Passw0rd" "$ROOT/.env"
  ! grep -q "s3cret-Passw0rd" "$DOCKER_LOG"
  [[ "$output" != *"s3cret-Passw0rd"* ]]
  # ...but they reach the container through the environment (-e NAME).
  grep -q "create_admin.py env=admin@example.org/Ada Admin/set" "$DOCKER_LOG"
}

# --- Fresh install -------------------------------------------------------------

@test "fresh install: merge, build, migrate, seed, up, Administrator, health, in that order" {
  run_setup
  [ "$status" -eq 0 ]
  [ -f "$ROOT/.env" ]
  build=$(call_line "compose --profile tools build")
  postgres=$(call_line "compose up -d --wait postgres")
  migrate=$(call_line "compose run --rm migrate$")
  seed=$(call_line "compose run --rm migrate pnpm exec prisma db seed")
  up=$(call_line "compose up -d$")
  admin=$(call_line "create_admin.py$")
  health=$(call_line "compose exec -T web")
  [ "$build" -gt 0 ] && [ "$build" -lt "$postgres" ] && [ "$postgres" -lt "$migrate" ]
  [ "$migrate" -lt "$seed" ] && [ "$seed" -lt "$up" ] && [ "$up" -lt "$admin" ] && [ "$admin" -lt "$health" ]
  # Fresh install: no point asking the database whether an Administrator exists.
  ! grep -q -- "--check" "$DOCKER_LOG"
  [[ "$output" == *"http://localhost:3000"* ]]
  [[ "$output" == *"admin@example.org"* ]]
}

@test "fresh install: secrets are generated, nothing warns about stored LLM keys" {
  run_setup
  [ "$status" -eq 0 ]
  grep -q '^SETTINGS_ENCRYPTION_KEY=".\+"' "$ROOT/.env"
  [[ "$output" != *"re-enter"* ]]
}

@test "legacy per-package .env files: says they are no longer read" {
  mkdir -p "$ROOT/apps/web"
  echo 'AUTH_SECRET="legacy-auth-secret"' >"$ROOT/apps/web/.env"
  run_setup
  [ "$status" -eq 0 ]
  [[ "$output" == *"apps/web/.env"*"no longer read"* ]]
}

# --- Re-run / upgrade ------------------------------------------------------------

@test "re-run with an Administrator: skips its creation, keeps .env byte for byte" {
  run_setup
  [ "$status" -eq 0 ]
  cp "$ROOT/.env" "$BATS_TEST_TMPDIR/first.env"
  : >"$DOCKER_LOG"
  STUB_VOLUMES=proj_postgres-data STUB_ADMIN_CHECK_EXIT=0 run_setup
  [ "$status" -eq 0 ]
  cmp "$ROOT/.env" "$BATS_TEST_TMPDIR/first.env"
  grep -q -- "create_admin.py --check" "$DOCKER_LOG"
  ! grep -q "create_admin.py$" "$DOCKER_LOG"
  [[ "$output" == *"already exists"* ]]
  # Still the upgrade path: images rebuilt, migrations and seed re-applied.
  grep -q "compose --profile tools build" "$DOCKER_LOG"
  grep -q "compose run --rm migrate$" "$DOCKER_LOG"
  grep -q "prisma db seed" "$DOCKER_LOG"
}

@test "existing database without an Administrator: creates one after migrating" {
  STUB_VOLUMES=proj_postgres-data STUB_ADMIN_CHECK_EXIT=3 run_setup
  [ "$status" -eq 0 ]
  check=$(call_line "create_admin.py --check")
  migrate=$(call_line "compose run --rm migrate$")
  admin=$(call_line "create_admin.py$")
  [ "$migrate" -lt "$check" ] && [ "$check" -lt "$admin" ]
}

@test "existing database, Administrator check errors: fails rather than guessing" {
  STUB_VOLUMES=proj_postgres-data STUB_ADMIN_CHECK_EXIT=1 run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"Administrator"* ]]
}

@test "new SETTINGS_ENCRYPTION_KEY on an existing database: warns to re-enter LLM keys" {
  STUB_VOLUMES=proj_postgres-data STUB_ADMIN_CHECK_EXIT=0 run_setup
  [ "$status" -eq 0 ]
  [[ "$output" == *"SETTINGS_ENCRYPTION_KEY"*"re-enter"* ]]
}

# --- LLM provider ----------------------------------------------------------------

@test "non-interactive provider and key: both land in .env, the key nowhere else" {
  LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-test-key run_setup
  [ "$status" -eq 0 ]
  grep -qx 'LLM_PROVIDER="anthropic"' "$ROOT/.env"
  grep -qx 'ANTHROPIC_API_KEY="sk-ant-test-key"' "$ROOT/.env"
  ! grep -q "sk-ant-test-key" "$DOCKER_LOG"
  [[ "$output" != *"sk-ant-test-key"* ]]
  [[ "$output" == *"LLM provider: anthropic"* ]]
}

@test "no provider (later): completes, nothing in .env, the summary points to the Admin screen" {
  run_setup
  [ "$status" -eq 0 ]
  ! grep -q '^LLM_PROVIDER=' "$ROOT/.env"
  [[ "$output" == *"Admin -> LLM providers"* ]]
}

@test "a provider without its key: fails naming the variable, starts nothing" {
  LLM_PROVIDER=openai run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"OPENAI_API_KEY"* ]]
  assert_nothing_started
}

@test "an unknown provider: fails naming the choices, starts nothing" {
  LLM_PROVIDER=gpt run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"anthropic"*"ollama"* ]]
  assert_nothing_started
}

@test "ollama without a base URL: the host's Ollama, as seen from the containers" {
  LLM_PROVIDER=ollama run_setup
  [ "$status" -eq 0 ]
  grep -qx 'LLM_PROVIDER="ollama"' "$ROOT/.env"
  grep -qx 'OLLAMA_BASE_URL="http://host.docker.internal:11434/v1"' "$ROOT/.env"
}

@test "re-run with a provider already in .env: kept, the key already there is enough" {
  LLM_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-key run_setup
  [ "$status" -eq 0 ]
  cp "$ROOT/.env" "$BATS_TEST_TMPDIR/first.env"
  STUB_VOLUMES=proj_postgres-data STUB_ADMIN_CHECK_EXIT=0 LLM_PROVIDER=anthropic run_setup
  [ "$status" -eq 0 ]
  cmp "$ROOT/.env" "$BATS_TEST_TMPDIR/first.env"
  [[ "$output" == *"LLM provider: openrouter"* ]]
}

@test "a key already in .env serves a provider chosen now" {
  echo 'ANTHROPIC_API_KEY="sk-ant-from-env-file"' >"$ROOT/.env"
  LLM_PROVIDER=anthropic run_setup
  [ "$status" -eq 0 ]
  grep -qx 'LLM_PROVIDER="anthropic"' "$ROOT/.env"
  grep -qx 'ANTHROPIC_API_KEY="sk-ant-from-env-file"' "$ROOT/.env"
}

# --- Optional integrations ----------------------------------------------------------

@test "integrations all skipped: completes, APP_URL defaults, the summary says what is off" {
  run_setup
  [ "$status" -eq 0 ]
  grep -qx 'APP_URL="http://localhost:3000"' "$ROOT/.env"
  grep -qx 'EMAIL_SERVER=""' "$ROOT/.env"
  grep -qx 'AUTH_GOOGLE_ID=""' "$ROOT/.env"
  [[ "$output" == *"Open http://localhost:3000"* ]]
  [[ "$output" == *"Sign-in methods: email + password"* ]]
  [[ "$output" != *"Sign-in methods: email + password, "* ]]
  [[ "$output" == *"France Travail: inactive"*"FRANCE_TRAVAIL_CLIENT_ID"* ]]
  [[ "$output" == *"Adzuna: inactive"*"developer.adzuna.com"* ]]
  [[ "$output" == *"Remotive, LinkedIn and HelloWork"*"no credentials"* ]]
}

@test "integrations from the environment: all land in .env, no secret elsewhere" {
  export_all_integrations
  run_setup
  [ "$status" -eq 0 ]
  grep -qx 'APP_URL="https://jobs.example.org"' "$ROOT/.env"
  grep -qx 'EMAIL_SERVER="smtp://mailer:smtp-pass-123@smtp.example.org:587"' "$ROOT/.env"
  grep -qx 'EMAIL_FROM="Jobs <jobs@example.org>"' "$ROOT/.env"
  grep -qx 'AUTH_GOOGLE_ID="google-id"' "$ROOT/.env"
  grep -qx 'AUTH_GOOGLE_SECRET="google-secret-123"' "$ROOT/.env"
  grep -qx 'AUTH_LINKEDIN_SECRET="linkedin-secret-123"' "$ROOT/.env"
  grep -qx 'FRANCE_TRAVAIL_CLIENT_SECRET="ft-secret-123"' "$ROOT/.env"
  grep -qx 'ADZUNA_APP_KEY="adzuna-key-123"' "$ROOT/.env"
  local secret
  for secret in smtp-pass-123 google-secret-123 linkedin-secret-123 ft-secret-123 adzuna-key-123; do
    ! grep -q "$secret" "$DOCKER_LOG"
    [[ "$output" != *"$secret"* ]]
  done
}

@test "integrations configured: the summary lists them as active and the URL as APP_URL" {
  export_all_integrations
  run_setup
  [ "$status" -eq 0 ]
  [[ "$output" == *"Open https://jobs.example.org"* ]]
  [[ "$output" == *"Sign-in methods: email + password, magic link (email), Google, LinkedIn"* ]]
  [[ "$output" == *"France Travail: active"* ]]
  [[ "$output" == *"Adzuna: active"* ]]
}

@test "half an integration's credentials: fails naming the missing variable, starts nothing" {
  AUTH_GOOGLE_ID=google-id run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"AUTH_GOOGLE_SECRET"* ]]
  assert_nothing_started
}

@test "a credential already in .env completes one given now" {
  echo 'ADZUNA_APP_ID="adzuna-from-env-file"' >"$ROOT/.env"
  ADZUNA_APP_KEY=adzuna-key run_setup
  [ "$status" -eq 0 ]
  grep -qx 'ADZUNA_APP_ID="adzuna-from-env-file"' "$ROOT/.env"
  grep -qx 'ADZUNA_APP_KEY="adzuna-key"' "$ROOT/.env"
  [[ "$output" == *"Adzuna: active"* ]]
}

@test "re-run: integrations already in .env are kept, even when the environment differs" {
  export_all_integrations
  run_setup
  [ "$status" -eq 0 ]
  cp "$ROOT/.env" "$BATS_TEST_TMPDIR/first.env"
  STUB_VOLUMES=proj_postgres-data STUB_ADMIN_CHECK_EXIT=0 APP_URL=http://other:3000 \
    AUTH_GOOGLE_ID=other-id AUTH_GOOGLE_SECRET=other-secret run_setup
  [ "$status" -eq 0 ]
  cmp "$ROOT/.env" "$BATS_TEST_TMPDIR/first.env"
  [[ "$output" == *"Open https://jobs.example.org"* ]]
}

# --- Health wait -------------------------------------------------------------------

@test "the app never answers: fails after the timeout, naming what didn't answer" {
  STUB_HEALTH_EXIT=1 SETUP_HEALTH_TIMEOUT=1 run_setup
  [ "$status" -eq 1 ]
  [[ "$output" == *"did not answer"* ]]
  [[ "$output" == *"docker compose logs"* ]]
}

# --- Arguments -----------------------------------------------------------------------

@test "unknown argument: exit 2" {
  run "$SETUP" --bogus
  [ "$status" -eq 2 ]
}
