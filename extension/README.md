# Ready Set: Ableton extension

Formerly tabridge; the code and command ids keep that name.

Build a song straight into the Live Set you have open: right-click a track/clip
slot/scene → **Ready Set: Import a song…**, then search online (Mutopia always,
BitMidi/FreeMIDI only when you turn on "Include fan-made MIDI (fine for practice,
not for release)") or drop in a Guitar Pro or MusicXML file. A result's play button
plays its opening in the list; a click on the result opens it, playing. Set a
transpose, **Build into Set**, and the tracks, notes, and a per-track **Pitch**
device appear in your project.

Built on the [Ableton Extensions SDK](https://ableton.github.io/extensions-sdk/)
(public beta, **Ableton Live 12.4.15 beta or later**). The parsing core is the tabridge Rust
crate compiled to a Node-target WASM module (`pkg/`), so the extension host
parses opened files and does the online fetches (no CORS) with the exact same
parser as the website. The modal reads an opened file and hands its bytes to
the host (the SDK has no file-picker API, so this relies on the webview's own
file input and drag and drop).

## What it does / doesn't

- Creates one MIDI track per instrument, names it, writes the notes, and inserts
  a **Pitch** device on every melodic track (drums excluded) set to your chosen
  transpose: the "one control per track" idea, Model A.
- Sets the song's tempo only in a fresh set, where no track has a clip yet
  (empty tracks, or tracks with just devices, still count as fresh). A set
  with material keeps its tempo; notes sit on bars and beats, so the song plays
  in time at it.
- Each track gets a stock instrument picked by its name: **Tension** for
  guitars and strings, **Operator** for bass, **Electric** for piano parts
  (named piano or keys, or for a score's hands and staves: up, down, RH, LH,
  as many Mutopia files are), **Wavetable** for the rest and as the fallback
  (Tension, Operator and Electric come with Live Suite). The preview voices
  each part alike: a plucked string, a round bass, an electric piano, a soft
  pad. Close, not the same: the preview plays in the window, not through
  Live's instruments.
- The Live note API writes discrete notes only, so **bends / slides / vibrato
  flatten here**. For full-fidelity articulations, use the website's `.als`
  export instead (same engine, different output).

## Local source modules

You can add your own search source without changing the extension. At startup
the host loads every CommonJS module (`*.js` or `*.cjs`) in the `sources`
folder of the extension's storage directory (the SDK's
`environment.storageDirectory`). The extension makes the folder, and the import
window shows it with a copy icon: open **Sources** next to the search box.
Since Ableton Live 12.4.15 an extension can't read anywhere else. A dev run
with no storage directory (`npm start`) uses `~/.ready-set/sources/` instead.

A module exports:

```js
module.exports = {
  id: "my-source",          // stable, unique
  label: "My source",       // shown on result rows, filters and the Sources list
  async search(query) {     // up to 25 hits
    return [{ id: "42", title: "Song", artist: "Artist", tracks: 3 }];  // artist, tracks optional
  },
  async load(id) {          // one of:
    return { gp: bytes };              // a Guitar Pro file (.gp, .gpx, .gp3-5), Uint8Array or Buffer
    // return { musicxml: text };      // MusicXML, as a string
    // return { midi: bytes };         // Standard MIDI File bytes
    // return { notesJson: json };     // Ready Set notes-JSON, see below
  },
};
```

Guitar Pro and MusicXML go through the same parser as a file you open. `notesJson` is the same shape the core's `midi_build_notes_json` returns:
`{ tempo, tracks: [{ name, isDrums, notes: [{ pitch, start, dur, velocity }] }],
sections?: [{ name, start, length }] }`, with `start`, `dur` and `length` in
beats. A module's results appear in search next to the built-in sources (always
searched, not tied to the fan-made MIDI switch), get the same inline intro,
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
`../shared/vendor/design/` (tokens with the fonts inlined as data URLs, the
value box, the controls and the icons) and `../shared/roll.js`, all injected
into the modal at build time (see `build.ts`).
