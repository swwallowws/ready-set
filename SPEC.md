# tabridge: Project Spec

> A Rust/WASM pipeline that turns scores and tabs (MusicXML, MIDI, Guitar Pro) into Standard MIDI files and Ableton Live projects (`.als`), with optional global transposition. Built for a minimal UX: open a file, get a ready-to-play set.

---

## 1. Goal & UX

The core user flow is intentionally tiny:

1. Provide a source: your own MusicXML, MIDI or Guitar Pro file, or a search result from a public archive.
2. The tool parses it into a normalized internal model.
3. It emits a **multi-track Standard MIDI File** (`.mid`): one track per instrument, with correct tempo, time signature, and General MIDI channel assignments, or an Ableton `.als`.
4. Optional: transpose all (or a selected subset of) tracks by N semitones before export.
5. The `.als` opens with each part on its own track, one Session clip per section, and stock instruments.

Everything compiles to **WebAssembly** so it can run in-browser (drop a file, download a set) or in the Ableton extension host.

---

## 2. High-level architecture

```
file / search result
        │
        ▼
   ┌─────────┐
   │ Source  │   parse the document (or fetch it first, via injected Http)
   │ adapter │
   └─────────┘
        │
        ▼
   normalized Score model  (Song → Track → Measure → Voice → Beat → Note)
        │
        ├──► MIDI writer (midly) ──► .mid
        │
        └──► ALS writer ──► .als (gzipped XML)
```

The **`Source` trait** is the key extensibility seam. Each source (Guitar Pro file, MusicXML) implements `load` and produces the same `Song` model. The MIDI writer and ALS writer are shared across all sources. Raw MIDI input takes a flat, beat-based path (`midi_read.rs`) straight to notes.

---

## 3. Module layout

```
src/
  lib.rs         // wasm-bindgen entry points
  model.rs       // typed Score model: Song, Track, Measure, Voice, Beat, Note, Tuning
  sources/
    mod.rs       // `trait Source { fn load(); }` + the Http seam
    musicxml.rs  // MusicXML score-partwise
    guitarpro.rs // GP3/4/5, .gpx, .gp
  midi.rs        // model -> midly SMF -> bytes
  midi_read.rs   // .mid -> flat notes (notes-JSON, flat .als)
  render.rs      // model -> timed note events
  transpose.rs   // global / per-track semitone shift over the model
  als.rs         // model -> Ableton .als (gzip XML)
```

---

## 4. Sources

- **File imports (main path):** MusicXML (uncompressed), Standard MIDI, Guitar Pro. Parsed locally, never uploaded.
- **Online search:** Mutopia (public domain, always on); BitMidi and FreeMIDI (user uploads, opt-in, personal use only). Each yields a `.mid`.
- **Local source modules (extension only):** optional user-installed modules that add a search source and return MIDI bytes or notes-JSON. See `extension/README.md`.

---

## 5. MIDI generation

No alphaTab in Rust, so we write MIDI directly. That is simpler than it sounds.

- **Crate `midly`:** pure Rust, `no_std`-capable, WASM-clean, MIT. Fast zero-copy SMF reader/writer. Handles multi-track, tempo, time signature, and all event types including pitch-bend (for bends/slides).
- **Core mapping math:**
  - For tab sources, MIDI note number = open-string tuning pitch + fret. `note_number(string_tuning: u8, fret: u8) -> u8 { string_tuning + fret }`
  - Duration: a rational fraction of a whole note → MIDI ticks. `ticks = num * 4 * ticks_per_quarter / denom`, with dots and tuplets folded into the fraction.
  - One MIDI track per instrument; assign General MIDI channels; drums on channel 10.
- Articulations (bends, slides, vibrato) map to pitch-bend in `.mid`/`.als`; the extension's note API writes discrete notes only.

### Free MIDI tooling summary
- **`midly`:** the writer. Use this.
- **alphaTab** (MPL, has a WASM build): a mature multi-format → model → MIDI library. Heavy JS/WASM dependency; skipped in favour of the Rust `guitarpro` crate so everything stays in one WASM core.
- **MuseScore** (GPL) / **TuxGuitar** (LGPL): free desktop tools to verify generated output against the original score.

---

## 6. WASM targets & crate compatibility

Constraint: in-browser WASM (`wasm32-unknown-unknown`) **cannot make arbitrary cross-origin requests**, and most archives send no CORS headers permitting direct fetches.

**Two deployment shapes:**
- **Browser WASM + thin proxy.** WASM does parse/MIDI in-page; a minimal proxy (`scripts/serve.py`) forwards allow-listed archive requests.
- **Node (the Ableton extension host).** A Node-target WASM build; the host fetches directly, no CORS.

Parsing + MIDI generation is pure compute and runs identically on either target with zero changes.

**Glue:** `wasm-bindgen` + `wasm-pack` for both builds.

---

## 7. Transposition

Global or per-track semitone shift, applied to the model **before** export (one `transpose.rs` pass over note numbers). Drum tracks are excluded via a track filter.

This doubles as a pipeline option: "generate MIDI and transpose by X semitones." Much simpler than transposing inside Ableton, where no built-in device transposes MIDI globally across tracks. The extension instead puts a **Pitch** device on every melodic track.

---

## 8. Ableton integration

A `.mid` file **cannot** carry Ableton racks, devices, or macro mappings. Those live in the `.als` project format (gzipped XML), a separate thing.

### Manual template
Build a Live template once: one MIDI track per typical instrument, a **Pitch** MIDI effect in a **MIDI Effect Rack** on each, Transpose mapped to Macro 1. Drag generated `.mid` clips onto matching tracks.

Note on Group Tracks: a Live Group Track is an **audio bus** rather than a MIDI bus, so dropping Pitch on a group does **not** reliably transpose child MIDI.

### Automated `.als` emission (done)
The pipeline emits a `.als` directly by cloning a real Live 12 template: one MIDI track per instrument with notes, one Scene per section, the tempo, and stock instruments (or instruments cloned from a user template).
- **Con:** `.als` format is undocumented and version-specific; re-check on Live upgrades.

---

## 9. Milestones

1. **Core pipeline:** `Source` trait → model → `midly` `.mid`. Verify output in MuseScore/TuxGuitar.
2. **Transpose pass:** global + per-track-filter semitone shift.
3. **WASM build:** `wasm-pack` browser target (+ thin proxy) and Node target (extension).
4. **Ableton:** manual template, then the `.als` emitter.
5. **Sources:** MusicXML (`sources/musicxml.rs`) and Guitar Pro GP3-GP7 (`sources/guitarpro.rs`, via the Rust `guitarpro` crate), both file imports on the website and in the extension. Done 2026-09-26.
6. **Extension:** Live Extensions SDK modal with search, preview, and build into the open Set; local source modules.

---

## 10. Legal note

Your own files are the main input. Mutopia's scores are public domain. BitMidi and FreeMIDI hold user-uploaded transcriptions of copyrighted songs, so they are off by default and labelled personal use only.

---

## 11. Adding a source

- A **file format** goes in `src/sources/` as a `Source` implementation, plus WASM bindings in `lib.rs`.
- A **search source** for the extension can live outside this repo as a local source module (`extension/README.md`).
