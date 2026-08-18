#!/usr/bin/env bash
# bb-tui live demo: spawn a hidden thread, stream its events from the plugin
# buffer, then stop + archive. Safe to re-run; self-cleaning.
set -euo pipefail
cd "$(dirname "$0")/../client"

# Required: the project to spawn the throwaway thread in (`bb project list`).
PROJECT="${PROJECT:?set PROJECT to a bb project id, e.g. PROJECT=proj_xxx $0}"
WATCH_SECS="${WATCH_SECS:-30}"
# Optional. Left blank, the thread spawns with the project's own defaults —
# pick a cheap model here if you run this often.
PROVIDER="${PROVIDER:-}"
MODEL="${MODEL:-}"
PROMPT="${PROMPT:-Write 200 short numbered sentences about terminal design. End with the exact line: DEMO_COMPLETE.}"

echo "== spawning hidden test thread (${PROVIDER:-project default} / ${MODEL:-project default}) =="
SPAWN=$(bb thread spawn --project "$PROJECT" --prompt "$PROMPT" --visibility hidden --json \
  ${PROVIDER:+--provider "$PROVIDER"} ${MODEL:+--model "$MODEL"})
TID=$(echo "$SPAWN" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "thread: $TID"

cleanup() {
  bb thread stop "$TID" >/dev/null 2>&1 || true
  bb thread archive "$TID" >/dev/null 2>&1 || true
  echo "== cleaned up: stopped + archived $TID =="
}
trap cleanup EXIT

echo "== streaming buffered events (${WATCH_SECS}s) =="
timeout "$WATCH_SECS" npx tsx src/cli.ts watch --thread "$TID" | tee /tmp/bb-tui-demo.log || true

echo "== per-type counts =="
awk -F'\t' '{print $3}' /tmp/bb-tui-demo.log | sort | uniq -c | sort -rn | head -8 || true