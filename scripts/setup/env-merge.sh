#!/usr/bin/env bash
# The .env merge (#259, part of `make setup`, #254).
#
# Builds the repo's root .env from:
#   - .env.example, which gives the layout, the comments and the defaults;
#   - the existing root .env, if any;
#   - the legacy apps/web/.env and packages/prisma/.env, if any;
#   - an optional answers file (KEY=value per line, raw, unquoted) holding what
#     the caller collected;
#   - freshly generated AUTH_SECRET, INTERNAL_API_SECRET and
#     SETTINGS_ENCRYPTION_KEY (a Fernet key), for whichever is missing.
#
# Rules, for each key:
#   1. a non-empty value in the root .env always wins;
#   2. then an answer, then a legacy value (legacy files only fill keys
#      .env.example knows: what nothing reads any more stays behind);
#   3. a secret still missing is generated. A secret is never regenerated:
#      a new SETTINGS_ENCRYPTION_KEY makes stored LLM keys undecryptable. The
#      values published in this repo (.env.example's placeholders, the old
#      per-package and docker-compose defaults) count as missing, though;
#   4. otherwise the root .env's (empty) value, else .env.example's default.
# A key .env.example only shows commented out stays commented out unless one
# of the sources sets it. Keys .env.example doesn't know are kept, in a
# section at the end. Comments in the old .env are not: .env.example's are.
#
# No prompting and no Docker orchestration: the caller asks the questions.
# Docker is used only to run openssl when the host has none.
#
# Usage: scripts/setup/env-merge.sh [--root DIR] [--answers FILE]
#   --root     the repo root to work in (default: this script's repo)
#   --answers  answers file, KEY=value per line
#
# Writes DIR/.env (mode 600) and reports on stdout, one line each:
#   legacy <path>     a legacy file was read; it is no longer used
#   generated <KEY>   a secret was generated
# Exit codes: 0 merged, 1 secrets could not be generated, 2 bad input.
# Nothing is written unless the whole merge succeeds.

set -euo pipefail

LEGACY_FILES="apps/web/.env packages/prisma/.env"
SECRET_KEYS="AUTH_SECRET INTERNAL_API_SECRET SETTINGS_ENCRYPTION_KEY"
# Published secret values, never kept: the old apps/web/.env.example's
# AUTH_SECRET, the old root .env.example's placeholders and the old
# docker-compose defaults. .env.example's own values
# for the secret keys are added to these by the merge itself.
PUBLISHED_SECRETS="changeme dev-auth-secret-change-me dev-internal-api-secret SbSkCyNxmIyTmRKah7LjMRn8Lsjf3f8OVkNH7iZoYaw="

die() {
  echo "env-merge: $1" >&2
  exit 2
}

root="$(cd "$(dirname "$0")/../.." && pwd)"
answers=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || die "--root needs a directory"; root="$2"; shift 2 ;;
    --answers) [ $# -ge 2 ] || die "--answers needs a file"; answers="$2"; shift 2 ;;
    *) die "unknown argument: $1 (usage: env-merge.sh [--root DIR] [--answers FILE])" ;;
  esac
done

example="$root/.env.example"
env_file="$root/.env"
[ -f "$example" ] || die ".env.example not found at $example"
[ -z "$answers" ] || [ -f "$answers" ] || die "answers file not found: $answers"

# openssl, or the same in a throwaway container.
run_openssl() {
  if command -v openssl >/dev/null 2>&1; then
    openssl "$@"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm alpine/openssl "$@"
  else
    echo "env-merge: generating secrets needs openssl, or Docker to run it in a container; found neither" >&2
    return 1
  fi
}

generate_secret() {
  case "$1" in
    AUTH_SECRET) run_openssl rand -base64 32 ;;
    INTERNAL_API_SECRET) run_openssl rand -hex 32 ;;
    # Fernet: 32 random bytes, url-safe base64.
    SETTINGS_ENCRYPTION_KEY) run_openssl rand -base64 32 | tr '+/' '-_' ;;
  esac
}

# Reads its inputs as `role=<role> <file>` pairs, in precedence-independent
# order: example, root, legacy..., answers, secrets. mode=missing prints the
# secret keys nothing provides; mode=merge writes the merged file to `out`
# and prints `generated <KEY>` for each generated secret used.
# shellcheck disable=SC2016 # awk's $ fields, not the shell's
MERGE_AWK='
function parse(line,   l, eq) {
  l = line
  sub(/^[ \t]+/, "", l)
  sub(/^export[ \t]+/, "", l)
  if (l !~ /^[A-Za-z_][A-Za-z0-9_]*=/) return 0
  eq = index(l, "=")
  K = substr(l, 1, eq - 1)
  V = substr(l, eq + 1)
  sub(/[ \t\r]+$/, "", V)
  return 1
}
function unquote(v) {
  if (v ~ /^".*"$/ || v ~ ("^" SQ ".*" SQ "$")) return substr(v, 2, length(v) - 2)
  return v
}
function usable(k, v,   u) {
  u = unquote(v)
  if (u == "") return 0
  if ((k in SECRET) && (u in PUBLISHED)) return 0
  return 1
}
function quote(k, v) {
  if (v !~ /[$"`\\]/) return "\"" v "\""
  if (index(v, SQ) == 0) return SQ v SQ
  print "env-merge: the value for " k " holds a single quote and one of $ \" ` \\, which no .env quoting keeps intact" > "/dev/stderr"
  failed = 1
  exit 2
}
function known(k) { return (k in EXKEY) || (k in COMMENTED) }
# The value K gets from the sources that beat a generated secret, or NONE.
function provided(k) {
  if ((k in ROOT) && usable(k, ROOT[k])) return ROOT[k]
  if (k in ANS) return ANS[k]
  if (k in LEGACY) return LEGACY[k]
  return NONE
}
function resolve(k,   v) {
  v = provided(k)
  if (v != NONE) return v
  if (k in GEN) { print "generated " k; return GEN[k] }
  if ((k in ROOT) && !(k in SECRET)) return ROOT[k]
  return NONE
}
BEGIN {
  NONE = "\001none"
  n = split(secret_keys, a, " ")
  for (i = 1; i <= n; i++) { SECRET[a[i]] = 1; SECRETORDER[i] = a[i] }
  nsecret = n
  n = split(published, a, " ")
  for (i = 1; i <= n; i++) PUBLISHED[a[i]] = 1
}
role == "example" {
  EX[++nex] = $0
  if (parse($0)) {
    EXKEY[K] = 1
    if ((K in SECRET) && unquote(V) != "") PUBLISHED[unquote(V)] = 1
  } else if ($0 ~ /^# [A-Za-z_][A-Za-z0-9_]*=/) {
    K = substr($0, 3, index($0, "=") - 3)
    if (!(K in COMMENTED)) { COMMENTED[K] = 1; CK[nex] = K }
  }
  next
}
role == "root" {
  if (parse($0)) {
    if (!(K in ROOT)) ROOTORDER[++nroot] = K
    ROOT[K] = V
  }
  next
}
role == "legacy" {
  if (parse($0) && known(K) && !(K in LEGACY) && usable(K, V)) LEGACY[K] = V
  next
}
role == "answers" {
  sub(/\r$/, "")
  if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
  K = substr($0, 1, index($0, "=") - 1)
  V = substr($0, index($0, "=") + 1)
  if (V == "") next
  if (!(K in ANS) && !(K in ROOT)) ANSORDER[++nans] = K
  ANS[K] = quote(K, V)
  next
}
role == "secrets" {
  if (parse($0)) GEN[K] = quote(K, V)
  next
}
END {
  if (failed) exit 2
  if (mode == "missing") {
    for (i = 1; i <= nsecret; i++)
      if (provided(SECRETORDER[i]) == NONE) print SECRETORDER[i]
    exit 0
  }
  for (i = 1; i <= nex; i++) {
    line = EX[i]
    if (parse(line) && !(K in DONE)) {
      v = resolve(K)
      if (v == NONE) v = V
      print K "=" v > out
      DONE[K] = 1
    } else if ((i in CK) && !(CK[i] in EXKEY) && (v = resolve(CK[i])) != NONE) {
      print CK[i] "=" v > out
      DONE[CK[i]] = 1
    } else {
      print line > out
    }
  }
  header = 0
  for (i = 1; i <= nroot + nans; i++) {
    k = (i <= nroot) ? ROOTORDER[i] : ANSORDER[i - nroot]
    if (known(k)) continue
    if (!header) {
      print "" > out
      print "# =============================================================================" > out
      print "# Not in .env.example (kept by make setup)" > out
      print "# =============================================================================" > out
      header = 1
    }
    print k "=" resolve(k) > out
  }
}
'

inputs=(role=example "$example" role=root "$([ -f "$env_file" ] && echo "$env_file" || echo /dev/null)")
legacy_read=()
for rel in $LEGACY_FILES; do
  if [ -f "$root/$rel" ]; then
    inputs+=(role=legacy "$root/$rel")
    legacy_read+=("$rel")
  fi
done
[ -z "$answers" ] || inputs+=(role=answers "$answers")

merge_awk() {
  awk -v SQ="'" -v secret_keys="$SECRET_KEYS" -v published="$PUBLISHED_SECRETS" "$@"
}

missing="$(merge_awk -v mode=missing "$MERGE_AWK" "${inputs[@]}")"

umask 077
tmp="$(mktemp "$root/.env.merge.XXXXXX")"
trap 'rm -f "$tmp" "$tmp.secrets"' EXIT
: >"$tmp.secrets"
for key in $missing; do
  value="$(generate_secret "$key")"
  [ -n "$value" ] || { echo "env-merge: generating $key produced nothing" >&2; exit 1; }
  printf '%s=%s\n' "$key" "$value" >>"$tmp.secrets"
done

merge_awk -v mode=merge -v out="$tmp" "$MERGE_AWK" "${inputs[@]}" role=secrets "$tmp.secrets"
chmod 600 "$tmp"
mv "$tmp" "$env_file"

for rel in ${legacy_read[@]+"${legacy_read[@]}"}; do
  echo "legacy $rel"
done
