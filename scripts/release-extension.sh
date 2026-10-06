#!/usr/bin/env bash
# Releases the Ableton Live extension in one go: builds the .ablx from main, tags
# v<version> (from extension/manifest.json), publishes a GitHub release with the
# file attached and your notes, then redeploys the website, whose "Coming soon"
# becomes the download (scripts/extension-link.mjs).
#
# Packaging runs here rather than in CI because it needs Ableton's Extensions SDK
# (extension/vendor/, which may not be redistributed).
#
# Before: raise "version" in extension/manifest.json on main, push, and write the
# release notes to a file (it stays out of git).
#   scripts/release-extension.sh <notes.md>
set -euo pipefail

notes="${1:?usage: release-extension.sh <notes.md>}"
[[ -f "$notes" ]] || { echo "no notes file: $notes" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
ext="$root/extension"
version="$(node -p "require('$ext/manifest.json').version")"
tag="v$version"

[[ "$(git -C "$root" branch --show-current)" == main ]] || { echo "release from main" >&2; exit 1; }
git -C "$root" diff --quiet HEAD || { echo "commit or stash your changes first" >&2; exit 1; }
git -C "$root" fetch -q origin main
[[ "$(git -C "$root" rev-parse HEAD)" == "$(git -C "$root" rev-parse origin/main)" ]] \
  || { echo "main and origin/main differ: push or pull first" >&2; exit 1; }
if git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null \
  || git -C "$root" ls-remote --exit-code --tags origin "$tag" >/dev/null; then
  echo "$tag exists: raise the version in extension/manifest.json" >&2; exit 1
fi

npm --prefix "$ext" run wasm
npm --prefix "$ext" test
npm --prefix "$ext" run package
file="$ext/Ready-Set-$version.ablx"
[[ -f "$file" ]] || { echo "the package step made no $file" >&2; exit 1; }

git -C "$root" tag -a "$tag" -m "Ready Set extension $tag"
git -C "$root" push origin "$tag"
gh release create "$tag" "$file" --repo swwallowws/ready-set --title "Ready Set $tag" --notes-file "$notes"
gh workflow run ci.yml --repo swwallowws/ready-set --ref main
echo "released $tag: https://github.com/swwallowws/ready-set/releases/tag/$tag (site redeploying)"
