#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

# jq filter to extract streaming text from assistant messages
stream_text='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty | gsub("\n"; "\r\n") | . + "\r\n\n"'

# jq filter to extract final result
final_result='select(.type == "result").result // empty'

for ((i=1; i<=$1; i++)); do
  tmpfile=$(mktemp)
  rawfile=$(mktemp)
  trap "rm -f $tmpfile $rawfile" EXIT

  commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
  issues=$(gh issue list --state open --json number,title,body,comments)
  prompt=$(cat ralph/prompt.md)

  set +e
  sbx run claude . -- \
    --verbose \
    --print \
    --output-format stream-json \
    "Previous commits: $commits $issues $prompt" \
    2>&1 \
  | tee "$rawfile" \
  | grep --line-buffered '^{' \
  | tee "$tmpfile" \
  | jq --unbuffered -rj "$stream_text"
  status=${PIPESTATUS[0]}
  set -e

  if [ "$status" -ne 0 ]; then
    if grep -qiE "OAuth session expired|Failed to authenticate" "$rawfile"; then
      echo ""
      echo "Session d'authentification sbx/claude expirée."
      echo "Reconnecte-toi avec: sbx secret set anthropic --oauth"
      echo "Arrêt après $((i-1)) itération(s) complétée(s) sur $1."
    else
      echo ""
      echo "sbx run a échoué (code $status) à l'itération $i, arrêt."
    fi
    exit 1
  fi

  result=$(jq -r "$final_result" "$tmpfile")

  if [[ "$result" == *"<promise>NO MORE TASKS</promise>"* ]]; then
    echo "Ralph complete after $i iterations."
    exit 0
  fi
done
