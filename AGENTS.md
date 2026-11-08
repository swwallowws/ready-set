# Ready Set

Turns scores and tabs into Ableton Live sets and MIDI files. One Rust core, compiled to WebAssembly,
runs in the browser and in an Ableton Live extension. The README explains it; this file is for
working on it.

## Working here

1. Do what was asked, the simplest way that meets it. Side work is a proposal that says what it costs.
2. Run the checks below for every path you changed. Report the numbers.
3. A commit's subject names what changed and the trap if there was one. Its body says why, what ran
   and what wasn't tested.
4. When something breaks and nobody saw it, add a rule here in the same commit as the fix.
5. The user pushes main, releases the extension and posts about it.

## Map

- `src/`: the Rust core (sources, the song model, the MIDI and `.als` writers); `SPEC.md` is the design
- `examples/`: command-line converters and the Guitar Pro report
- `web/`: the browser app; `scripts/serve.py` runs it with the search proxy
- `extension/`: the Ableton Live extension (`src/extension.ts`, its window in `src/interface.html`)
- `shared/`: what the web app and the extension share (the roll, the player, the design system copy)
- `scripts/`: deploy, release, smoke and sound checks
- `third_party/guitarpro/`: the vendored Guitar Pro parser, with its one patch
- `docs/`: `browser.md` (proxy and bindings) and `ableton-template.md`

## Rules

**This folder is Ready Set.** The old `tabridge` folder pushes to `ready-set-archive` and is never
worked in or deployed from: a fix made there once dropped newer work from the live site.
Check: `git remote -v` names `swwallowws/ready-set`.

**Pushing main is the deploy.** CI builds the site with `scripts/deploy-web.sh --stage` and
publishes it to GitHub Pages, so `deploy-web.sh --push` is never run by hand. That script copies a
fixed list of files: a new file the site needs (a vendored sound file, say) goes on that list.
Check: CI on the push.

**The extension host is not plain Node.** There is no global `URL`: import it from `node:url` (a
bare `new URL` once killed the host). An uncaught throw anywhere, a request handler included, exits
the whole host, so callbacks are wrapped. Since Ableton Live 12.4.15 the file system is open only
inside the extension's storage and temp folders. The host logs to
`~/Library/Preferences/Ableton/Live <version>/ExtensionHost.txt`, outside the working folders: ask
the user to `tail` it. Check: `npm --prefix extension test`; manual in Live.

**The window looks like an Ableton extension.** 400 × 420 (`extension.ts`), small type like
Session Notes' window (mostly 11 to 13px, 24px controls). The design system's 15 and 14px scale is
for the web app, not here. Check: `scripts/modal_preview.py` renders the window outside Live.

**Releasing the extension publishes it.** `scripts/release-extension.sh <notes.md>` makes a public
GitHub release, so it runs only on the user's go, each time. Check: none.

## Checks

| Changed | Run |
|---|---|
| `src/**`, `examples/**`, `third_party/**` | `cargo test` |
| `extension/**` | `npm --prefix extension test` |
| `web/**`, `shared/**` | `scripts/web_smoke.py` (with `scripts/serve.py` running), `node scripts/test_hero.mjs` |
| the player or the bank | `scripts/web_player_check.py`, `scripts/hero_sound_check.py` |
