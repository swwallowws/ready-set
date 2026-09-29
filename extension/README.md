# Ready Set: Ableton extension

Formerly tabridge; the code and command ids keep that name.

Build a song straight into the Live Set you have open: right-click a track/clip
slot/scene → **Ready Set: Import a song…**, open a MusicXML or MIDI file (or
search online: Mutopia always, BitMidi/FreeMIDI only when you tick "Include
fan-made MIDI (fine for practice, not for release)"), set a transpose, and the tracks, notes, and a per-track
**Pitch** device appear in your project.

Built on the [Ableton Extensions SDK](https://ableton.github.io/extensions-sdk/)
(public beta, **Live 12 Suite 12.4.5+**). The parsing core is the tabridge Rust
crate compiled to a Node-target WASM module (`pkg/`), so the extension host
parses opened files and does the online fetches (no CORS) with the exact same
parser as the website. The modal reads an opened file and hands its bytes to
the host (the SDK has no file-picker API, so this relies on the webview's own
file input and drag and drop).

## What it does / doesn't

- Creates one MIDI track per instrument, names it, writes the notes, sets the
  tempo, and inserts a **Pitch** device on every melodic track (drums excluded)
  set to your chosen transpose: the "one control per track" idea, Model A.
- The Live note API writes discrete notes only, so **bends / slides / vibrato
  flatten here**. For full-fidelity articulations, use the website's `.als`
  export instead (same engine, different output).

## Local source modules

You can add your own search source without changing the extension. At startup
the host loads every CommonJS module (`*.js` or `*.cjs`) it finds in:

1. `<storage directory>/sources/`, where the storage directory is the one Live
   gives the extension (the SDK's `environment.storageDirectory`; the host logs
   the exact folder at startup), then
2. `~/.ready-set/sources/` (useful for `npm start` dev runs, which have no
   storage directory).

A module exports:

```js
module.exports = {
  id: "my-source",          // stable, unique
  label: "My source",       // shown on result rows, filters and the Sources list
  async search(query) {     // up to 25 hits
    return [{ id: "42", title: "Song", artist: "Artist", tracks: 3 }];  // artist, tracks optional
  },
  async load(id) {          // one of:
    return { midi: bytes };            // Standard MIDI File bytes (Uint8Array or Buffer)
    // return { notesJson: json };     // Ready Set notes-JSON, see below
  },
};
```

`notesJson` is the same shape the core's `midi_build_notes_json` returns:
`{ tempo, tracks: [{ name, isDrums, notes: [{ pitch, start, dur, velocity }] }],
sections?: [{ name, start, length }] }`, with `start`, `dur` and `length` in
beats. A module's results appear in search next to the built-in sources (always
searched, not tied to the fan-made MIDI checkbox), get the same inline intro,
preview and Build, and are labelled with its `label`. A module that fails to
load or has the wrong shape is skipped and logged. With no modules installed,
nothing changes. Modules run inside the extension host with full Node access,
so only install code you trust. Restart the extension (or Live) after adding
one.

## Develop

The Ableton Extensions SDK isn't included in this repo (its licence doesn't
allow redistribution). Get `ableton-extensions-sdk-1.0.0-beta.0.tgz` and
`ableton-extensions-cli-1.0.0-beta.0.tgz` from Ableton and place them in
`vendor/` before installing.

```sh
npm install                 # installs the SDK + CLI from vendor/ + build tools
npm run wasm                # (re)build the Rust core -> pkg/ (needs wasm-pack)
npm run build               # typecheck + bundle -> dist/extension.js (+ wasm)
npm test                    # local source module hook (needs pkg/)
npm start                   # build, then run in a connected Live via the CLI
npm run package             # produce a distributable .ablx
```

Shares its look with the website via the design system in
`../shared/vendor/design/` (tokens, with the fonts inlined as data URLs) and
`../shared/roll.js`, both injected into the modal at build time (see `build.ts`).
