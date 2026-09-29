//! tabridge: turn scores and tabs (MusicXML, MIDI, Guitar Pro) into Standard
//! MIDI files and Ableton Live sets.
//!
//! Pipeline: [`Source::load`] → normalized [`model::Song`] → optional
//! [`transpose`] → [`midi`] `.mid` bytes or [`als`] `.als` bytes. Any network
//! access is injected via [`sources::Http`], so the same source code runs on
//! every target. In the browser, JS does any fetching and the `wasm` bindings
//! below do the pure parse/transpose/emit in-page.
//!
//! [`Source::load`]: sources::Source::load

pub mod als;
pub mod midi;
pub mod midi_read;
pub mod model;
pub mod render;
pub mod sources;
pub mod transpose;

/// Run any [`Source`](sources::Source) to MIDI bytes: load → optional global
/// transpose (excluding drums; `0` skips) → emit. The shared backend for the
/// per-source entry points.
pub fn load_to_midi(
    source: &dyn sources::Source,
    input: &str,
    semitones: i32,
    http: &dyn sources::Http,
) -> Result<Vec<u8>, String> {
    let mut song = source.load(input, http).map_err(|e| e.to_string())?;
    if semitones != 0 {
        transpose::transpose(&mut song, semitones, &transpose::TrackFilter::exclude_drums());
    }
    midi::write_midi(&song)
}

/// Parse a MusicXML document (uncompressed `score-partwise`) to MIDI bytes.
pub fn musicxml_to_midi(xml: &str, semitones: i32) -> Result<Vec<u8>, String> {
    load_to_midi(&sources::MusicXml::new(), xml, semitones, &sources::NoHttp)
}

/// Run any [`Source`](sources::Source) to Ableton `.als` (gzipped XML) bytes:
/// load → optional transpose → emit. Transposition is baked into the notes;
/// see [`als`] for the Live-12 caveats.
pub fn load_to_als(
    source: &dyn sources::Source,
    input: &str,
    semitones: i32,
    http: &dyn sources::Http,
) -> Result<Vec<u8>, String> {
    let mut song = source.load(input, http).map_err(|e| e.to_string())?;
    if semitones != 0 {
        transpose::transpose(&mut song, semitones, &transpose::TrackFilter::exclude_drums());
    }
    als::write_als(&song)
}

/// Like [`load_to_als`], but clones tracks from a caller-supplied Live set
/// (gunzipped `.als` XML), so exported tracks carry that template's
/// instruments/devices. See [`als::write_als_with_template`].
pub fn load_to_als_with_template(
    source: &dyn sources::Source,
    input: &str,
    semitones: i32,
    http: &dyn sources::Http,
    template_xml: &str,
) -> Result<Vec<u8>, String> {
    let mut song = source.load(input, http).map_err(|e| e.to_string())?;
    if semitones != 0 {
        transpose::transpose(&mut song, semitones, &transpose::TrackFilter::exclude_drums());
    }
    als::write_als_with_template(&song, template_xml)
}

/// Parse a MusicXML document to an Ableton `.als` project (built-in template).
pub fn musicxml_to_als(xml: &str, semitones: i32) -> Result<Vec<u8>, String> {
    load_to_als(&sources::MusicXml::new(), xml, semitones, &sources::NoHttp)
}

/// Parse a MusicXML document to an `.als`, cloning tracks from `template_xml`.
pub fn musicxml_to_als_with_template(
    xml: &str,
    semitones: i32,
    template_xml: &str,
) -> Result<Vec<u8>, String> {
    load_to_als_with_template(&sources::MusicXml::new(), xml, semitones, &sources::NoHttp, template_xml)
}

/// Serialize a [`model::Song`] to the Ableton-Extension / Live-Object-Model
/// JSON shape: `{ tempo, tracks: [{ name, isDrums, notes: [{ pitch, start, dur,
/// velocity }] }] }`, with `start`/`dur` in beats. Articulations (bend/slide/
/// vibrato) are dropped: the Extensions note API writes discrete notes only;
/// use the `.als`/`.mid` path to keep pitch-bends.
pub fn song_to_notes_json(song: &model::Song) -> Result<String, String> {
    let tracks: Vec<serde_json::Value> = song
        .tracks
        .iter()
        .map(|t| {
            let (_, events) = render::track_events(t);
            let notes: Vec<serde_json::Value> = events
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "pitch": e.pitch, "start": e.start, "dur": e.dur, "velocity": e.velocity
                    })
                })
                .collect();
            serde_json::json!({ "name": t.name, "isDrums": t.is_drums, "notes": notes })
        })
        .collect();
    // Section beat-spans so the extension can mirror the .als Session view
    // (one Scene per section, per-section clips). name + start + length in beats.
    let sections: Vec<serde_json::Value> = als::section_spans_beats(song)
        .into_iter()
        .map(|(name, start, length)| serde_json::json!({ "name": name, "start": start, "length": length }))
        .collect();
    serde_json::to_string(&serde_json::json!({ "tempo": song.tempo, "tracks": tracks, "sections": sections }))
        .map_err(|e| e.to_string())
}

// ---- Browser-WASM entry points (wasm-bindgen glue) ----------------------
//
// The browser can't make arbitrary cross-origin requests, so JS does any
// fetching (via a thin proxy) and these bindings do the pure compute: parse a
// document or file, transpose, and emit notes-JSON, `.mid` or `.als` bytes.

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    use crate::sources::MusicXml;
    use crate::transpose::{transpose, TrackFilter};

    /// Route panics to the browser console during development.
    #[wasm_bindgen(start)]
    pub fn start() {
        #[cfg(feature = "panic-hook")]
        console_error_panic_hook::set_once();
    }

    // ---- MusicXML source (self-contained; no network / payloads) ----------
    // `<score-partwise>` as exported by MuseScore and most score editors.
    // Uncompressed only (.xml / .musicxml, not zipped .mxl).

    /// Parse a MusicXML document into a Song, applying an optional transpose.
    fn assemble_musicxml(xml: &str, semitones: i32) -> Result<crate::model::Song, JsValue> {
        let mut song = MusicXml::new().parse(xml).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if semitones != 0 {
            transpose(&mut song, semitones, &TrackFilter::exclude_drums());
        }
        Ok(song)
    }

    /// Notes-JSON (extension route) from a MusicXML document.
    #[wasm_bindgen]
    pub fn musicxml_build_notes_json(xml: &str, semitones: i32) -> Result<String, JsValue> {
        let song = assemble_musicxml(xml, semitones)?;
        crate::song_to_notes_json(&song).map_err(|e| JsValue::from_str(&e))
    }

    /// Standard MIDI File from a MusicXML document.
    #[wasm_bindgen]
    pub fn musicxml_build_midi(xml: &str, semitones: i32) -> Result<Vec<u8>, JsValue> {
        let song = assemble_musicxml(xml, semitones)?;
        crate::midi::write_midi(&song).map_err(|e| JsValue::from_str(&e))
    }

    /// Ableton `.als` (built-in template) from a MusicXML document.
    #[wasm_bindgen]
    pub fn musicxml_build_als(xml: &str, semitones: i32) -> Result<Vec<u8>, JsValue> {
        let song = assemble_musicxml(xml, semitones)?;
        crate::als::write_als(&song).map_err(|e| JsValue::from_str(&e))
    }

    /// `.als` cloning instruments/devices from a caller-supplied Live set.
    #[wasm_bindgen]
    pub fn musicxml_build_als_with_template(xml: &str, semitones: i32, template_xml: &str) -> Result<Vec<u8>, JsValue> {
        let song = assemble_musicxml(xml, semitones)?;
        crate::als::write_als_with_template(&song, template_xml).map_err(|e| JsValue::from_str(&e))
    }

    // ---- Guitar Pro source (self-contained; GP3/4/5, .gpx, .gp) ------------
    // Binary files, so these take bytes. Same outputs as MusicXML: the tab's
    // bars, sections, tempo map and articulations carry into the .als.

    /// Parse Guitar Pro bytes into a Song, applying an optional transpose.
    fn assemble_guitarpro(bytes: &[u8], semitones: i32) -> Result<crate::model::Song, JsValue> {
        let mut song = crate::sources::GuitarPro::new().parse(bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if semitones != 0 {
            transpose(&mut song, semitones, &TrackFilter::exclude_drums());
        }
        Ok(song)
    }

    /// True when the bytes look like a Guitar Pro file (any supported version).
    #[wasm_bindgen]
    pub fn is_guitarpro(bytes: &[u8]) -> bool {
        crate::sources::GuitarPro::sniff(bytes).is_some()
    }

    /// Notes-JSON (extension route) from a Guitar Pro file.
    #[wasm_bindgen]
    pub fn guitarpro_build_notes_json(bytes: &[u8], semitones: i32) -> Result<String, JsValue> {
        let song = assemble_guitarpro(bytes, semitones)?;
        crate::song_to_notes_json(&song).map_err(|e| JsValue::from_str(&e))
    }

    /// Standard MIDI File from a Guitar Pro file.
    #[wasm_bindgen]
    pub fn guitarpro_build_midi(bytes: &[u8], semitones: i32) -> Result<Vec<u8>, JsValue> {
        let song = assemble_guitarpro(bytes, semitones)?;
        crate::midi::write_midi(&song).map_err(|e| JsValue::from_str(&e))
    }

    /// Ableton `.als` (built-in template) from a Guitar Pro file.
    #[wasm_bindgen]
    pub fn guitarpro_build_als(bytes: &[u8], semitones: i32) -> Result<Vec<u8>, JsValue> {
        let song = assemble_guitarpro(bytes, semitones)?;
        crate::als::write_als(&song).map_err(|e| JsValue::from_str(&e))
    }

    /// `.als` cloning instruments/devices from a caller-supplied Live set.
    #[wasm_bindgen]
    pub fn guitarpro_build_als_with_template(bytes: &[u8], semitones: i32, template_xml: &str) -> Result<Vec<u8>, JsValue> {
        let song = assemble_guitarpro(bytes, semitones)?;
        crate::als::write_als_with_template(&song, template_xml).map_err(|e| JsValue::from_str(&e))
    }

    // ---- Standard MIDI File source (self-contained; note-level, no bars) ---
    // A .mid fetched from a MIDI archive (e.g. BitMidi) or a local file. Emits
    // the flat notes-JSON (the extension / preview route), or an .als built via
    // the flat, beat-based path (notes at absolute beats, marker-derived scenes).

    /// Notes-JSON (extension route) from Standard MIDI File bytes.
    #[wasm_bindgen]
    pub fn midi_build_notes_json(bytes: &[u8], semitones: i32) -> Result<String, JsValue> {
        crate::midi_read::midi_to_notes_json(bytes, semitones).map_err(|e| JsValue::from_str(&e))
    }

    /// `.als` (Ableton Live set) from Standard MIDI File bytes, via the flat
    /// beat-based writer. Non-drum channels transposed by `semitones`.
    #[wasm_bindgen]
    pub fn midi_build_als(bytes: &[u8], semitones: i32) -> Result<Vec<u8>, JsValue> {
        let song = crate::midi_read::parse_midi(bytes, semitones).map_err(|e| JsValue::from_str(&e))?;
        crate::als::write_als_flat(&song).map_err(|e| JsValue::from_str(&e))
    }

    /// `.als` from Standard MIDI File bytes, cloning tracks from a caller-supplied
    /// Live set (the extension's active-set template route).
    #[wasm_bindgen]
    pub fn midi_build_als_with_template(
        bytes: &[u8],
        semitones: i32,
        template_xml: &str,
    ) -> Result<Vec<u8>, JsValue> {
        let song = crate::midi_read::parse_midi(bytes, semitones).map_err(|e| JsValue::from_str(&e))?;
        crate::als::write_als_flat_with_template(&song, template_xml).map_err(|e| JsValue::from_str(&e))
    }

    /// Transpose a .mid and return the new bytes (for the web MIDI preview /
    /// download). Non-drum channels only; unchanged at 0 semitones.
    #[wasm_bindgen]
    pub fn midi_transpose(bytes: &[u8], semitones: i32) -> Result<Vec<u8>, JsValue> {
        crate::midi_read::midi_transpose(bytes, semitones).map_err(|e| JsValue::from_str(&e))
    }
}
