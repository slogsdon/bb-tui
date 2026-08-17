#!/usr/bin/env bash
# bb-tui live demo: spawn a hidden thread, stream its events from the plugin
# buffer, then stop + archive. Safe to re-run; self-cleaning.
set -euo pipefail
cd "$(dirname "$0")/../client"

PROJECT="${PROJECT:-proj_m8bt3ak4h3}"   # default: Personal (this host)
WATCH_SECS="${WATCH_SECS:-30}"
PROMPT="${PROMPT:-Write 200 short numbered sentences about terminal design. End with the exact line: DEMO_COMPLETE.}"

echo "== spawning hidden test thread (codex) =="
SPAWN=$(bb thread spawn --project "$PROJECT" --prompt "$PROMPT" --provider codex --visibility hidden --json)
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