# Browser web app (WASM + thin proxy)

`web/` is a small in-browser app: open your own MusicXML, MIDI or Guitar Pro
file (or search online), and download a `.mid` or Ableton `.als`; the WASM
does all the parsing/emitting client-side.

Because `wasm32-unknown-unknown` can't make cross-origin requests and the
online archives send no permissive CORS headers (SPEC §6), a **thin proxy**
forwards the allow-listed search and download requests. It does no logic.

## Run it

```sh
# 1. Build the WASM package into web/pkg/
wasm-pack build --target web --out-dir web/pkg

# 2. Serve the UI + proxy (stdlib Python, no deps)
scripts/serve.py            # http://localhost:8000
```

Then open the URL, drop a file (or search, e.g. "bach minuet"), choose format +
transpose, and Download.

## How it works

The page (`web/app.js`) drives this flow:

1. **Your file:** read locally; MIDI and Guitar Pro are sniffed from their
   bytes, anything else is parsed as MusicXML.
2. **Search:** Mutopia always, BitMidi and FreeMIDI when "Include fan-made
   MIDI" is ticked, each through `./proxy?url=…` (FreeMIDI downloads through
   `./freemidi?id=…`, which does its two-step cookie handshake server-side).
   Every online result is a `.mid`. The page asks `./site.json` first:
   `serve.py` answers `{"proxy": true}`; the static build answers
   `{"proxy": false}` (see "Static site" below).
3. **Build:** `musicxml_build_*`, `guitarpro_build_*` or `midi_build_als` /
   `midi_transpose` (WASM) → bytes → browser download.

## Notes

- The proxy (`scripts/serve.py`) only forwards `bitmidi.com`, `freemidi.org`
  and `mutopiaproject.org`; anything else is `403`.
- **Instruments out of the box:** drop a gunzipped Live set at
  `web/template.als.xml` (git-ignored). If present, `.als` exports clone its
  tracks (instruments, MPE, devices) so they play immediately; the page shows
  "Instruments: included". Without it, a built-in minimal template is used
  (named tracks + notes, no instruments; add them in Live). Use a *clean* set
  (not a generated `.als`), with stock instruments (Tension/Drift/Wavetable etc.)
  for cross-machine portability; sample-based kits resolve only where their
  packs are installed.
- `web/pkg/` is build output (git-ignored); regenerate with `wasm-pack`.

## Static site

`scripts/deploy-web.sh --stage DIR` builds the WASM and stages a static copy
(main page, `/try/`, `pkg/`, `shared/`, favicons, README, MIT LICENSE, NOTICE)
for `swwallowws/ready-set-web` on GitHub Pages. All paths are relative, so it
works under `/ready-set-web/`. With no proxy there, the page offers what a
browser reaches on its own (checked 2026-09-29 by requesting each source with
a `github.io` Origin header and reading `Access-Control-Allow-Origin`):

- **BitMidi:** its JSON API and `.mid` files send `Access-Control-Allow-Origin: *`,
  so the page fetches them directly.
- **Mutopia:** no CORS headers, so live search is out; the page searches the
  frozen `/try/` catalogue (public-domain pieces shipped with the site).
- **FreeMIDI:** no CORS headers and a cookie handshake a page can't do
  cross-origin, so it is left out (the extension and `serve.py` keep it).
- No `template.als.xml` is shipped; `.als` exports use the built-in template.
