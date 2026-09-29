#!/usr/bin/env bash
# Build the website and stage it for swwallowws/ready-set-web (GitHub Pages,
# served at https://swwallowws.github.io/ready-set-web/).
#   scripts/deploy-web.sh --stage DIR       build and stage into DIR (no git)
#   scripts/deploy-web.sh --push CHECKOUT   stage into a clone of ready-set-web, commit, push
# Pushing publishes the site: only with Bengisu's explicit go.
#
# The staged site is static: no serve.py, so its site.json points app.js at
# the hosted proxy (ready-set-proxy on Deno Deploy) for live
# Mutopia and FreeMIDI; BitMidi is fetched directly. Every page uses relative
# paths, so it works under the /ready-set-web/ subpath.
set -euo pipefail

# Base URL of the hosted proxy (answers /proxy?url= and /freemidi?id=).
PROXY_URL="https://ready-set-proxy.swwallowws.deno.net/"

mode="${1:-}"; target="${2:-}"
if [[ "$mode" != "--stage" && "$mode" != "--push" ]] || [[ -z "$target" ]]; then
  echo "usage: $0 --stage DIR | --push CHECKOUT" >&2; exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"

wasm-pack build "$root" --target web --out-dir web/pkg

mkdir -p "$target"
find "$target" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

# Pages: the main page, /try/ and its catalogue, favicons.
cp "$root/web/index.html" "$root/web/app.js" "$target/"
cp -R "$root/web/try" "$root/web/favicons" "$target/"
# WASM: only the module and its glue (wasm-pack's pkg/.gitignore would hide
# the folder from git, and its README is the code repo's).
mkdir -p "$target/pkg"
cp "$root/web/pkg/tabridge.js" "$root/web/pkg/tabridge_bg.wasm" "$target/pkg/"
# Shared files (serve.py mounts ../shared at /shared locally; here it's a folder).
mkdir -p "$target/shared/vendor/design/fonts" "$target/shared/vendor/design/sound/spessasynth"
cp "$root/shared/roll.js" "$root/shared/sources.js" "$root/shared/midiplay.js" "$root/shared/midiplay.css" "$target/shared/"
cp "$root"/shared/vendor/design/*.css "$root"/shared/vendor/design/*.js "$target/shared/vendor/design/"
cp "$root"/shared/vendor/design/fonts/* "$target/shared/vendor/design/fonts/"
# The preview's sounds: the design system's shared General MIDI bank (and its
# NOTICE), played by the design system's spessasynth (and its LICENSE and NOTICE;
# the .d.ts stays behind).
cp "$root/shared/vendor/design/sound/gm.sf3" "$root/shared/vendor/design/sound/NOTICE" "$target/shared/vendor/design/sound/"
cp "$root"/shared/vendor/design/sound/spessasynth/*.min.js "$root/shared/vendor/design/sound/spessasynth/LICENSE" "$root/shared/vendor/design/sound/spessasynth/NOTICE" "$target/shared/vendor/design/sound/spessasynth/"

# The hosted proxy, and no local Live template on a static host.
printf '{"proxy": "%s", "template": false}\n' "$PROXY_URL" > "$target/site.json"

cp "$root/web/deploy/README.md" "$root/web/deploy/LICENSE" "$target/"
{
  cat "$root/web/deploy/NOTICE"
  # Drop cargo's markers ("(/path)", "(ssh://...)", "(proc-macro)", repeat "(*)") but
  # keep parenthesized license expressions; Ready Set's own crates are not third party.
  cargo tree --manifest-path "$root/Cargo.toml" -p tabridge --target wasm32-unknown-unknown \
    -e normal --prefix none --format "{p} {l}" \
    | sed -E 's/ \((\/[^)]*|ssh:[^)]*|proc-macro|\*)\)//g; s/ +$//' \
    | grep -v -E '^(tabridge|expressive-liveset) ' | sort -u
} > "$target/NOTICE"
touch "$target/.nojekyll"

if [[ "$mode" == "--push" ]]; then
  git -C "$target" add -A
  git -C "$target" commit -m "Deploy Ready Set $(git -C "$root" rev-parse --short HEAD)"
  git -C "$target" push
fi
echo "staged in $target"
