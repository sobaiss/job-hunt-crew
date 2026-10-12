#!/usr/bin/env bash
# `make setup` (#261, part of #254): from a fresh clone to a running app with
# an Administrator, needing only Docker and make on the host. Also the upgrade
# path: re-run it after `git pull` to rebuild the images, apply new migrations
# and re-upsert the seed data. It keeps .env's values and never regenerates a
# secret.
#
# Steps:
#   1. prerequisites: docker (daemon running), Docker Compose v2, make, and
#      ports 3000, 5432, 8000, 9000, 9324 free (or held by this stack);
#   2. the root .env, through env-merge.sh (secrets generated once);
#   3. the LLM provider and its key (or ollama's URL), asked or, non-
#      interactively, read from LLM_PROVIDER and the provider's variable;
#      skippable ("later"), not asked again once .env names a provider;
#   4. the first Administrator's email, name and password: asked (password
#      masked and confirmed) or, non-interactively, read from ADMIN_EMAIL /
#      ADMIN_NAME / ADMIN_PASSWORD. Never written to a file or a command line.
#      On an existing database this waits until after the migrations, then
#      offers to skip when an Administrator exists;
#   5. build, Postgres up, `prisma migrate deploy`, seed, the stack up, all in
#      containers;
#   6. the Administrator, created in the `api` container (create_admin.py);
#   7. wait for the API's /healthz and the web's 200;
#   8. a summary.
#
# Non-interactive when SETUP_NONINTERACTIVE=1 or stdin isn't a terminal.
# SETUP_HEALTH_TIMEOUT (seconds, default 300) bounds the health wait.
#
# Usage: scripts/setup/setup.sh [--root DIR]
# Exit codes: 0 done, 1 a step failed (named on stderr), 2 bad arguments.
# Bash 3.2-compatible (macOS).

set -euo pipefail

usage_error() {
  echo "setup: $1 (usage: setup.sh [--root DIR])" >&2
  exit 2
}

root="$(cd "$(dirname "$0")/../.." && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || usage_error "--root needs a directory"; root="$(cd "$2" && pwd)"; shift 2 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done
cd "$root"

# service:port, for every port the stack publishes on the host.
STACK_PORTS="web:3000 postgres:5432 api:8000 minio:9000 elasticmq:9324"
HEALTH_TIMEOUT="${SETUP_HEALTH_TIMEOUT:-300}"
HEALTH_INTERVAL="${SETUP_HEALTH_INTERVAL:-3}"
CREATE_ADMIN="uv run --no-sync --package api python packages/py-db/scripts/create_admin.py"
NO_ADMINISTRATOR_EXIT_CODE=3

step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() {
  printf '\nsetup: %s\n' "$1" >&2
  exit 1
}

if [ "${SETUP_NONINTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
  interactive=0
else
  interactive=1
fi

# --- 1. Prerequisites --------------------------------------------------------

port_in_use() {
  (: <"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Is the program on this port one of this stack's containers (a re-run)?
port_held_by_stack() {
  [ -n "$(docker ps -q --filter "publish=$1" --filter "label=com.docker.compose.project.working_dir=$root")" ]
}

check_prerequisites() {
  step "Checking prerequisites"
  command -v docker >/dev/null 2>&1 ||
    fail "Docker is not installed. Install Docker Desktop (macOS, Windows with WSL) or Docker Engine (Linux): https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 ||
    fail "the Docker daemon isn't running (or this user can't reach it). Start Docker Desktop, or the docker service, and re-run."
  docker compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 (the \`docker compose\` command) is missing. It ships with Docker Desktop; on Linux install the docker-compose-plugin package."
  command -v make >/dev/null 2>&1 ||
    fail "make is not installed (macOS: xcode-select --install; Debian/Ubuntu: apt install make)."
  if ! command -v openssl >/dev/null 2>&1; then
    note "openssl not found: the secrets will be generated in a container."
  fi

  local busy="" pair service port
  for pair in $STACK_PORTS; do
    service="${pair%%:*}"
    port="${pair##*:}"
    if port_in_use "$port" && ! port_held_by_stack "$port"; then
      busy="$busy
    port $port (for $service)"
    fi
  done
  if [ -n "$busy" ]; then
    fail "these ports are in use by another program:$busy
Stop what is using them and re-run. Port 3000 is often \`pnpm dev\` or \`make web-up\`."
  fi
  note "Docker, Docker Compose v2 and make found; ports free."
}

# --- 2. .env -----------------------------------------------------------------

# Set by merge_env: whether a new SETTINGS_ENCRYPTION_KEY was generated.
new_encryption_key=0

merge_env() {
  step "Writing .env"
  local report line
  report="$(scripts/setup/env-merge.sh --root "$root")" || fail "the .env merge failed (see above)."
  while IFS= read -r line; do
    case "$line" in
      "legacy "*) note "Imported ${line#legacy }: it is no longer read, the root .env replaces it. You can delete it." ;;
      "generated SETTINGS_ENCRYPTION_KEY") new_encryption_key=1; note "Generated SETTINGS_ENCRYPTION_KEY." ;;
      "generated "*) note "Generated ${line#generated }." ;;
    esac
  done <<EOF
$report
EOF
  note ".env is ready (existing values kept)."
}

# A value from .env, as env-merge.sh writes it (double- or single-quoted,
# never escaped); empty when unset or commented out.
env_value() {
  local value
  value="$(grep "^$1=" .env | tail -1)" || true
  value="${value#*=}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# --- 3. LLM provider ---------------------------------------------------------

# The values docker-compose passes to the api and worker (huggingface isn't
# offered interactively, but an environment may name it).
LLM_PROVIDER_CHOICES="anthropic openai openrouter huggingface ollama"
# A host Ollama, as the containers reach it.
OLLAMA_FROM_CONTAINERS="http://host.docker.internal:11434/v1"

# The .env variable a provider needs: its API key, or ollama's server URL.
llm_parameter() {
  case "$1" in
    anthropic) echo ANTHROPIC_API_KEY ;;
    openai) echo OPENAI_API_KEY ;;
    openrouter) echo OPENROUTER_API_KEY ;;
    huggingface) echo HF_TOKEN ;;
    ollama) echo OLLAMA_BASE_URL ;;
  esac
}

# Set by configure_llm: the provider in .env, empty when none ("later").
llm_provider=""
llm_value=""

# Sets llm_provider (empty: later) and, unless .env already has it, llm_value.
ask_llm() {
  local answer parameter
  printf '\nThe LLM provider Analyses run on (Admin -> LLM providers can change it later):\n'
  echo "  1) anthropic   2) openai   3) openrouter   4) ollama (a local server)   5) later"
  while :; do
    read -r -p "  Choice [5]: " answer
    case "$answer" in
      1 | anthropic) llm_provider=anthropic ;;
      2 | openai) llm_provider=openai ;;
      3 | openrouter) llm_provider=openrouter ;;
      4 | ollama) llm_provider=ollama ;;
      "" | 5 | later) llm_provider=""; return ;;
      *) echo "  Pick 1 to 5."; continue ;;
    esac
    break
  done
  parameter="$(llm_parameter "$llm_provider")"
  if [ -n "$(env_value "$parameter")" ]; then
    note "Using the $parameter already in .env."
  elif [ "$llm_provider" = "ollama" ]; then
    read -r -p "  Ollama URL [$OLLAMA_FROM_CONTAINERS]: " llm_value
    llm_value="${llm_value:-$OLLAMA_FROM_CONTAINERS}"
  else
    read -r -s -p "  $parameter (Enter to decide later): " llm_value
    echo
    [ -n "$llm_value" ] || llm_provider=""
  fi
}

# LLM_PROVIDER and its key in .env, through env-merge.sh: asked, or read from
# the environment (LLM_PROVIDER plus the provider's variable). Not asked again
# once .env names a provider. No provider is a valid answer: Analyses then
# fail naming the missing parameter until an Administrator sets one.
configure_llm() {
  step "LLM provider"
  llm_provider="$(env_value LLM_PROVIDER)"
  if [ -n "$llm_provider" ]; then
    note "LLM_PROVIDER is already set in .env ($llm_provider): kept."
    return
  fi

  local parameter
  if [ "$interactive" = "1" ]; then
    ask_llm
  else
    llm_provider="$(printf '%s' "${LLM_PROVIDER:-}" | tr '[:upper:]' '[:lower:]')"
    if [ -n "$llm_provider" ]; then
      case " $LLM_PROVIDER_CHOICES " in
        *" $llm_provider "*) ;;
        *) fail "unknown LLM_PROVIDER \"$llm_provider\": use one of $LLM_PROVIDER_CHOICES, or leave it unset to configure it later." ;;
      esac
      parameter="$(llm_parameter "$llm_provider")"
      llm_value="${!parameter:-}"
      if [ -z "$llm_value" ] && [ -z "$(env_value "$parameter")" ]; then
        [ "$llm_provider" = "ollama" ] ||
          fail "LLM_PROVIDER=$llm_provider needs $parameter: set it too, or unset LLM_PROVIDER to configure it later."
        llm_value="$OLLAMA_FROM_CONTAINERS"
      fi
    fi
  fi

  if [ -z "$llm_provider" ]; then
    note "No LLM provider for now."
    return
  fi
  parameter="$(llm_parameter "$llm_provider")"
  # Answers go through a private file: the key never shows on a command line.
  local answers
  answers="$(umask 077 && mktemp)"
  {
    echo "LLM_PROVIDER=$llm_provider"
    [ -z "$llm_value" ] || echo "$parameter=$llm_value"
  } >"$answers"
  scripts/setup/env-merge.sh --root "$root" --answers "$answers" >/dev/null || {
    rm -f "$answers"
    fail "writing the LLM provider to .env failed (see above)."
  }
  rm -f "$answers"
  note "LLM_PROVIDER=$llm_provider written to .env."
}

# Does this stack already have a Postgres volume, i.e. a database?
database_exists() {
  local project
  project="$(docker compose config --format json | sed -n 's/^ *"name": "\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=postgres-data")" ]
}

# --- 4. Administrator inputs -------------------------------------------------

check_password() {
  [ "${#1}" -ge 8 ] || fail "the Administrator's password must be at least 8 characters."
}

ask_admin() {
  local password confirm
  printf '\nThe first Administrator (you sign in with this email and password):\n'
  ADMIN_EMAIL=""
  while [ -z "$ADMIN_EMAIL" ]; do
    read -r -p "  Email: " ADMIN_EMAIL
    case "$ADMIN_EMAIL" in *@*) ;; *) echo "  That doesn't look like an email address."; ADMIN_EMAIL="" ;; esac
  done
  ADMIN_NAME=""
  while [ -z "$ADMIN_NAME" ]; do
    read -r -p "  Name: " ADMIN_NAME
  done
  while :; do
    read -r -s -p "  Password (at least 8 characters): " password
    echo
    if [ "${#password}" -lt 8 ]; then
      echo "  Too short."
      continue
    fi
    read -r -s -p "  Password again: " confirm
    echo
    [ "$password" = "$confirm" ] && break
    echo "  The passwords don't match."
  done
  ADMIN_PASSWORD="$password"
}

# Fills ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD, from the user or the
# environment, and exports them for `docker compose run -e`.
collect_admin() {
  if [ "$interactive" = "1" ]; then
    ask_admin
  else
    local missing="" var
    for var in ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD; do
      eval "[ -n \"\${$var:-}\" ]" || missing="$missing${missing:+, }$var"
    done
    [ -z "$missing" ] ||
      fail "non-interactive setup needs the first Administrator: set $missing (used for this run only, never written to .env)."
    check_password "$ADMIN_PASSWORD"
  fi
  export ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD
}

# Exit 0: one exists; 1: none; anything else from create_admin is a failure.
administrator_exists() {
  local code=0
  # shellcheck disable=SC2086 # CREATE_ADMIN is a command line
  docker compose run --rm --no-deps api $CREATE_ADMIN --check >/dev/null || code=$?
  case "$code" in
    0) return 0 ;;
    "$NO_ADMINISTRATOR_EXIT_CODE") return 1 ;;
    *) fail "couldn't tell whether an Administrator exists (create_admin --check exited $code)." ;;
  esac
}

# On an existing database: called once migrated. Sets create_admin=1 when one
# should be created, collecting the inputs.
decide_admin_on_existing_database() {
  if ! administrator_exists; then
    note "No Administrator yet."
    collect_admin
    create_admin=1
    return
  fi
  if [ "$interactive" = "1" ]; then
    local answer
    read -r -p "An Administrator already exists. Create another one? [y/N] " answer
    case "$answer" in
      [yY]*) collect_admin; create_admin=1; return ;;
    esac
  fi
  note "An Administrator already exists: skipped. (More later: see create_admin in the README.)"
}

# --- 5.-7. The stack ---------------------------------------------------------

start_stack() {
  step "Building the images (the first time takes several minutes)"
  docker compose --profile tools build || fail "the image build failed (see above)."

  step "Starting Postgres"
  docker compose up -d --wait postgres || fail "Postgres didn't start (see \`docker compose logs postgres\`)."

  step "Applying database migrations"
  docker compose run --rm migrate || fail "the migrations failed (see above)."

  step "Seeding the base data"
  docker compose run --rm migrate pnpm exec prisma db seed || fail "the seed failed (see above)."

  step "Starting the stack"
  docker compose up -d || fail "the stack didn't start (see \`docker compose logs\`)."
}

create_administrator() {
  step "Creating the Administrator"
  # -e NAME: the value comes from this process's environment, never argv.
  # shellcheck disable=SC2086 # CREATE_ADMIN is a command line
  docker compose run --rm --no-deps -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD api $CREATE_ADMIN ||
    fail "creating the Administrator failed (see above)."
}

api_answers() {
  docker compose exec -T api python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz', timeout=5)" >/dev/null 2>&1
}

web_answers() {
  docker compose exec -T web node -e "fetch('http://localhost:3000/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1
}

wait_for_health() {
  step "Waiting for the app to answer"
  local start waiting
  start=$SECONDS
  while :; do
    waiting=""
    api_answers || waiting="the API (/healthz)"
    web_answers || waiting="$waiting${waiting:+ and }the web app (/)"
    [ -n "$waiting" ] || break
    if [ $((SECONDS - start)) -ge "$HEALTH_TIMEOUT" ]; then
      fail "$waiting did not answer within ${HEALTH_TIMEOUT}s. See \`docker compose logs api web\`."
    fi
    sleep "$HEALTH_INTERVAL"
  done
  note "API and web app are up."
}

# --- Main --------------------------------------------------------------------

check_prerequisites
merge_env
configure_llm

create_admin=0
existing_database=0
if database_exists; then
  existing_database=1
else
  collect_admin
  create_admin=1
fi

start_stack

if [ "$existing_database" = "1" ]; then
  step "Checking for an Administrator"
  decide_admin_on_existing_database
fi
[ "$create_admin" = "0" ] || create_administrator

wait_for_health

app_url="${AUTH_URL:-http://localhost:3000}"
step "Done"
note "Open $app_url"
if [ "$create_admin" = "1" ]; then
  note "Sign in as the Administrator: $ADMIN_EMAIL"
else
  note "Sign in with your existing Administrator account."
fi
if [ -n "$llm_provider" ]; then
  note "LLM provider: $llm_provider (from .env; Admin -> LLM providers can override it)."
else
  note "No LLM provider configured: Analyses fail until you set one in"
  note "Admin -> LLM providers (or re-run make setup)."
fi
if [ "$existing_database" = "1" ] && [ "$new_encryption_key" = "1" ]; then
  echo
  note "A new SETTINGS_ENCRYPTION_KEY was generated for an existing database: LLM"
  note "keys saved from Admin -> LLM providers can no longer be read. Please re-enter"
  note "them there (until then, the LLM keys in .env are used)."
fi
echo
note "Day to day: make up / make down. To upgrade: git pull, then make setup."
