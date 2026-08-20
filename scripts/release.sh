#!/usr/bin/env bash
# Publish both halves from this machine. CI proves everything below except the
# publish itself, so npm credentials stay off GitHub.
#
#   scripts/release.sh              # verify and pack, publish nothing
#   scripts/release.sh --publish    # …then publish both packages for real
#
# Publishing is not reversible: a version, once taken on npm, is taken. Run the
# default form first and read what it says it will ship.
set -euo pipefail
cd "$(dirname "$0")/.."

publish=false
[ "${1:-}" = "--publish" ] && publish=true

scripts/check-versions.sh
version=$(node -p 'require("./client/package.json").version')

echo "==> installing locked dependencies"
npm --prefix bb-plugin-bb-tui ci
npm --prefix client ci

echo "==> typecheck + tests"
npm --prefix bb-plugin-bb-tui run typecheck
npm --prefix bb-plugin-bb-tui test
npm --prefix client run typecheck
npm --prefix client test

echo "==> building both halves"
npm --prefix bb-plugin-bb-tui run build
npm --prefix client run build

# The plugin's dist/ is gitignored, so a missing `files` allowlist would ship a
# tarball with no artifact in it. Look inside before trusting the config.
echo "==> what each tarball would contain"
for pkg in bb-plugin-bb-tui client; do
  (cd "$pkg" && npm pack --dry-run --json) > "/tmp/$pkg-pack.json"
  node -e '
    const p = require(`/tmp/${process.argv[1]}-pack.json`)[0];
    const files = p.files.map((f) => f.path);
    const want = process.argv.slice(2);
    for (const w of want) {
      if (!files.includes(w)) throw new Error(`${p.name} is missing ${w}`);
    }
    console.log(`    ${p.name}@${p.version}  ${files.length} files, ${p.size} bytes`);
  ' "$pkg" $([ "$pkg" = client ] && echo "dist/index.js dist/cli.js" || echo "server.ts dist/server.js")
done

if [ "$publish" != true ]; then
  echo
  echo "dry run only. to publish v$version:"
  echo "  scripts/release.sh --publish"
  exit 0
fi

echo "==> publishing v$version"
(cd bb-plugin-bb-tui && npm publish --access public)
(cd client && npm publish --access public)

echo
echo "published v$version. tag it so git installs can find the same code:"
echo "  git tag -a v$version -m 'v$version' && git push origin v$version"
