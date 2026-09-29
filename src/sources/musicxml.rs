//! MusicXML source (SPEC §4): `score-partwise`, uncompressed.
//!
//! MusicXML is the open notation interchange format exported by MuseScore and
//! most score editors. A MusicXML document is self-contained, so this source
//! just parses it: no network.
//!
//! Mapping into the model:
//! * each `<part>` → a [`Track`] (name + GM program from `<part-list>`);
//! * `<measure>` → [`Measure`]; notes are grouped by `<voice>` into [`Voice`]s;
//! * `<note>` duration is in *divisions* (per quarter), converted to a
//!   [`Duration`] fraction; `<chord/>` stacks onto the current beat; `<rest/>`
//!   and `<forward>` advance time without sounding;
//! * pitch from `<step>`/`<octave>`/`<alter>`; absolute, so no tuning.
//!
//! v1 scope / limitations: `score-partwise` only; `<backup>` is ignored (voices
//! are bucketed in document order, which covers typical exports); unpitched
//! percussion is mapped only when the part declares a `<midi-unpitched>` note.
//! Compressed `.mxl` (zip) is out of scope: unzip first.

use std::collections::HashMap;

use roxmltree::{Document, Node, ParsingOptions};

use super::{Http, Source, SourceError};
use crate::model::{Articulation, Beat, Duration, Measure, Note, Song, TimeSignature, Track, Tuning, Voice};

/// The MusicXML adapter.
#[derive(Debug, Default, Clone, Copy)]
pub struct MusicXml;

impl MusicXml {
    pub fn new() -> Self {
        MusicXml
    }

    /// Parse an uncompressed MusicXML `score-partwise` document into a [`Song`].
    pub fn parse(&self, xml: &str) -> Result<Song, SourceError> {
        // MusicXML files carry a `<!DOCTYPE …>`; allow it. roxmltree does not
        // resolve external entities, so this stays safe against XXE.
        let opts = ParsingOptions { allow_dtd: true, ..ParsingOptions::default() };
        let doc =
            Document::parse_with_options(xml, opts).map_err(|e| SourceError::Parse(e.to_string()))?;
        let root = doc.root_element();
        if root.tag_name().name() != "score-partwise" {
            return Err(SourceError::Parse(format!(
                "unsupported MusicXML root <{}> (only score-partwise)",
                root.tag_name().name()
            )));
        }

        let part_meta = parse_part_list(root);
        let tracks: Vec<Track> = root
            .children()
            .filter(|n| n.has_tag_name("part"))
            .map(|p| parse_part(p, &part_meta))
            .collect();

        let first_measure = tracks.first().and_then(|t| t.measures.first());
        let tempo = first_measure.and_then(|m| m.tempo).unwrap_or(120.0);
        let time_signature = first_measure.and_then(|m| m.time_signature).unwrap_or_default();

        Ok(Song {
            title: title(root),
            artist: composer(root),
            tempo,
            time_signature,
            tracks,
        })
    }
}

impl Source for MusicXml {
    /// Load from raw MusicXML text, or fetch it from a URL via `http`.
    fn load(&self, input: &str, http: &dyn Http) -> Result<Song, SourceError> {
        let trimmed = input.trim_start();
        if trimmed.starts_with('<') {
            self.parse(input)
        } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let bytes = http.get(trimmed)?;
            self.parse(&String::from_utf8_lossy(&bytes))
        } else {
            Err(SourceError::UnrecognizedInput(
                "expected MusicXML text (starting with '<') or a URL".into(),
            ))
        }
    }
}

/// Per-part metadata gathered from `<part-list>`.
struct PartMeta {
    name: String,
    program: u8,
    is_drums: bool,
    /// GM percussion note for unpitched parts that declare a single mapping.
    unpitched: Option<u8>,
}

fn parse_part_list<'a>(root: Node<'a, 'a>) -> HashMap<String, PartMeta> {
    let mut map = HashMap::new();
    let Some(part_list) = root.children().find(|n| n.has_tag_name("part-list")) else {
        return map;
    };
    for sp in part_list.children().filter(|n| n.has_tag_name("score-part")) {
        let Some(id) = sp.attribute("id") else { continue };
        let name = child_text(sp, "part-name").unwrap_or("").trim().to_string();

        let midi = sp.children().find(|n| n.has_tag_name("midi-instrument"));
        // MusicXML midi-program / midi-channel are 1-based.
        let program = midi
            .and_then(|m| child_text(m, "midi-program"))
            .and_then(|s| s.trim().parse::<i32>().ok())
            .map(|p| (p - 1).clamp(0, 127) as u8)
            .unwrap_or(0);
        let channel = midi
            .and_then(|m| child_text(m, "midi-channel"))
            .and_then(|s| s.trim().parse::<i32>().ok());
        let unpitched = midi
            .and_then(|m| child_text(m, "midi-unpitched"))
            .and_then(|s| s.trim().parse::<i32>().ok())
            .map(|n| (n - 1).clamp(0, 127) as u8);
        let is_drums = channel == Some(10) || unpitched.is_some();

        map.insert(id.to_string(), PartMeta { name, program, is_drums, unpitched });
    }
    map
}

fn parse_part<'a>(part: Node<'a, 'a>, part_meta: &HashMap<String, PartMeta>) -> Track {
    let meta = part.attribute("id").and_then(|id| part_meta.get(id));
    let (name, program, is_drums, unpitched) = match meta {
        Some(m) => (m.name.clone(), m.program, m.is_drums, m.unpitched),
        None => (String::new(), 0, false, None),
    };

    let mut divisions: u32 = 1; // carried across measures
    let measures = part
        .children()
        .filter(|n| n.has_tag_name("measure"))
        .map(|m| parse_measure(m, &mut divisions, unpitched))
        .collect();

    Track { name, instrument: program, tuning: Tuning::default(), is_drums, measures }
}

fn parse_measure<'a>(measure: Node<'a, 'a>, divisions: &mut u32, unpitched: Option<u8>) -> Measure {
    // <attributes><divisions> updates the running value; <time> may change.
    let mut time_signature = None;
    for attr in measure.children().filter(|n| n.has_tag_name("attributes")) {
        if let Some(d) = child_text(attr, "divisions").and_then(|s| s.trim().parse::<u32>().ok()) {
            *divisions = d.max(1);
        }
        if let Some(time) = attr.children().find(|n| n.has_tag_name("time")) {
            if let (Some(n), Some(d)) = (
                child_text(time, "beats").and_then(|s| s.trim().parse::<u8>().ok()),
                child_text(time, "beat-type").and_then(|s| s.trim().parse::<u8>().ok()),
            ) {
                time_signature = Some(TimeSignature::new(n.max(1), d.max(1)));
            }
        }
    }

    // Tempo: first <sound tempo="…"> anywhere in the measure.
    let tempo = measure
        .descendants()
        .find(|n| n.has_tag_name("sound") && n.attribute("tempo").is_some())
        .and_then(|n| n.attribute("tempo"))
        .and_then(|t| t.parse::<f64>().ok());

    // Bucket beats by voice, in first-seen order. <chord/> stacks onto the
    // current voice's last beat; <rest/> and <forward> add empty (silent) beats.
    let whole = (*divisions * 4).max(1);
    let mut voices: Vec<(String, Vec<Beat>)> = Vec::new();
    let mut current_voice = String::from("1");

    for node in measure.children() {
        match node.tag_name().name() {
            "note" => {
                let voice = child_text(node, "voice").unwrap_or("1").trim().to_string();
                current_voice = voice.clone();
                let dur = child_text(node, "duration")
                    .and_then(|s| s.trim().parse::<u32>().ok())
                    .unwrap_or(0);
                let beats = voice_beats(&mut voices, &voice);

                let note = note_pitch(node, unpitched).map(|pitch| {
                    let articulation = parse_articulation(node);
                    let velocity = if articulation.accent { 115 } else { 90 };
                    Note { pitch, velocity, bend: None, articulation, tied: has_tie(node) }
                });

                if node.children().any(|c| c.has_tag_name("chord")) {
                    // Chord tone: attach to the current beat, no time advance.
                    if let (Some(last), Some(n)) = (beats.last_mut(), note) {
                        last.notes.push(n);
                    }
                } else {
                    beats.push(Beat {
                        duration: Duration::from_fraction(dur, whole),
                        notes: note.into_iter().collect(),
                    });
                }
            }
            "forward" => {
                // Advance the current voice's time with a silent beat.
                let dur = child_text(node, "duration")
                    .and_then(|s| s.trim().parse::<u32>().ok())
                    .unwrap_or(0);
                if dur > 0 {
                    voice_beats(&mut voices, &current_voice).push(Beat {
                        duration: Duration::from_fraction(dur, whole),
                        notes: Vec::new(),
                    });
                }
            }
            // <backup> is intentionally ignored: voices are kept in document
            // order, which covers typical exports.
            _ => {}
        }
    }

    // Section label from a rehearsal mark, if present.
    let marker = measure
        .descendants()
        .find(|n| n.has_tag_name("rehearsal"))
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Measure {
        voices: voices.into_iter().map(|(_, beats)| Voice { beats }).collect(),
        time_signature,
        tempo,
        marker,
    }
}

/// Get (creating if needed) the beat list for `voice`, preserving order.
fn voice_beats<'a>(voices: &'a mut Vec<(String, Vec<Beat>)>, voice: &str) -> &'a mut Vec<Beat> {
    if let Some(i) = voices.iter().position(|(v, _)| v == voice) {
        &mut voices[i].1
    } else {
        voices.push((voice.to_string(), Vec::new()));
        &mut voices.last_mut().unwrap().1
    }
}

/// Absolute MIDI pitch of a note, or `None` for a rest / unresolved unpitched.
fn note_pitch(note: Node, unpitched: Option<u8>) -> Option<u8> {
    if note.children().any(|c| c.has_tag_name("rest")) {
        return None;
    }
    if let Some(p) = note.children().find(|c| c.has_tag_name("pitch")) {
        let step = child_text(p, "step")?.trim();
        let octave: i32 = child_text(p, "octave")?.trim().parse().ok()?;
        let alter: i32 = child_text(p, "alter").and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let semitone = match step {
            "C" => 0,
            "D" => 2,
            "E" => 4,
            "F" => 5,
            "G" => 7,
            "A" => 9,
            "B" => 11,
            _ => return None,
        };
        let midi = (octave + 1) * 12 + semitone + alter;
        return Some(midi.clamp(0, 127) as u8);
    }
    // Unpitched percussion: use the part's declared GM note if available.
    if note.children().any(|c| c.has_tag_name("unpitched")) {
        return unpitched;
    }
    None
}

fn parse_articulation(note: Node) -> Articulation {
    let has = |tag: &str| note.descendants().any(|n| n.has_tag_name(tag));
    Articulation {
        slide: has("slide") || has("glissando"),
        harmonic: has("harmonic"),
        staccato: has("staccato"),
        accent: has("accent") || has("strong-accent"),
        ..Articulation::default()
    }
}

/// A note tied *from* the previous note (`<tie type="stop">`), so it continues
/// rather than re-attacks.
fn has_tie(note: Node) -> bool {
    note.children()
        .filter(|n| n.has_tag_name("tie"))
        .any(|n| n.attribute("type") == Some("stop"))
}

fn child_text<'a>(node: Node<'a, 'a>, tag: &str) -> Option<&'a str> {
    node.children().find(|n| n.has_tag_name(tag)).and_then(|n| n.text())
}

fn title(root: Node) -> String {
    root.descendants()
        .find(|n| n.has_tag_name("work-title"))
        .or_else(|| root.descendants().find(|n| n.has_tag_name("movement-title")))
        .and_then(|n| n.text())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn composer(root: Node) -> String {
    root.descendants()
        .find(|n| n.has_tag_name("creator") && n.attribute("type") == Some("composer"))
        .and_then(|n| n.text())
        .unwrap_or("")
        .trim()
        .to_string()
}
