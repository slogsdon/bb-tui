#!/usr/bin/env bash
# Both packages release from one tag, so a half-matching tag is the one release
# failure users cannot see: npm and git installs would describe different code
# under the same version. Assert the lockstep before anything is published.
#
#   scripts/check-versions.sh            # the two packages agree with each other
#   scripts/check-versions.sh v0.2.0     # …and with the tag being released
set -euo pipefail
cd "$(dirname "$0")/.."

plugin=$(node -p 'require("./bb-plugin-bb-tui/package.json").version')
client=$(node -p 'require("./client/package.json").version')

if [ "$plugin" != "$client" ]; then
  echo "version drift: plugin $plugin != client $client" >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  want=${1#v}
  if [ "$plugin" != "$want" ]; then
    echo "tag $1 does not match package version $plugin" >&2
    exit 1
  fi
fi

echo "version $plugin (plugin + client in lockstep)"
