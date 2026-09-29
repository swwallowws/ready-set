//! Model → Ableton Live 12 project (`.als`), per SPEC §8, Option A.
//!
//! Writing the Live set itself (cloning template tracks with unique ids, clips
//! with per-note pitch curves, tempo, scenes) lives in the shared
//! `expressive-liveset` crate, which clones a real Live 12.4.1 set. This module
//! maps a [`Song`] onto it:
//!
//! * one `<MidiTrack>` per [`Track`](crate::model::Track), cloned from the template track of the
//!   closest instrument family;
//! * one Session clip per section, one scene per section with its tempo;
//! * a whole-song Arrangement clip per track, and the song's tempo map.
//!
//! Transposition is baked into the notes only if requested; by default notes
//! stay at original pitch and the cloned Pitch device sits at 0, ready for an
//! interactive transpose. The melodic vs. drum template tracks are detected by
//! the presence of a `<DrumGroupDevice>` (a Drum Rack).
//!
//! ⚠️ Version-specific: this targets Live 12.4.1. Re-template on upgrade.

use expressive_liveset as live;

use crate::model::{Song, TimeSignature};
use crate::render::{pitch_curve, Event};

/// Render a [`Song`] to `.als` bytes using the built-in template, with a stock
/// instrument on every track (Drum Rack on drum parts, Tension on the rest) so
/// the set plays as soon as it opens.
pub fn write_als(song: &Song) -> Result<Vec<u8>, String> {
    let owned = instrumented()?;
    let blocks: Vec<&str> = owned.iter().map(String::as_str).collect();
    live::write(&song_set(song, &blocks), live::TEMPLATE)
}

/// Render a [`Song`] to `.als` bytes by cloning tracks from a caller-supplied
/// Live set (gunzipped XML). Pitched tracks clone the first non-drum track;
/// drum tracks clone the first track containing a Drum Rack. Whatever the
/// template track carries (instruments, devices, macro mappings) comes along;
/// only the name and notes are replaced.
pub fn write_als_with_template(song: &Song, template_xml: &str) -> Result<Vec<u8>, String> {
    live::write(&song_set(song, &live::template_tracks(template_xml)), template_xml)
}

/// Render a raw MIDI file to `.als` bytes via the flat, beat-based path
/// (notes at absolute beats, marker-derived sections, one tempo). Uses the
/// built-in template with stock instruments, as [`write_als`].
pub fn write_als_flat(song: &crate::midi_read::FlatSong) -> Result<Vec<u8>, String> {
    let owned = instrumented()?;
    let blocks: Vec<&str> = owned.iter().map(String::as_str).collect();
    live::write(&flat_set(song, &blocks), live::TEMPLATE)
}

/// Flat `.als` from a caller-supplied Live set (as [`write_als_with_template`],
/// but for raw MIDI without notated rhythm).
pub fn write_als_flat_with_template(
    song: &crate::midi_read::FlatSong,
    template_xml: &str,
) -> Result<Vec<u8>, String> {
    live::write(&flat_set(song, &live::template_tracks(template_xml)), template_xml)
}

/// The built-in template's one track, once with Tension and once with a Drum
/// Rack. [`pick`] then finds the drum block by its Drum Rack and uses the other
/// for every pitched part. A caller's own template brings its own instruments.
fn instrumented() -> Result<[String; 2], String> {
    let base = live::template_tracks(live::TEMPLATE)
        .first()
        .copied()
        .ok_or("the built-in template has no track")?;
    Ok([
        live::with_instrument(live::TEMPLATE, base, live::Instrument::Melodic)?,
        live::with_instrument(live::TEMPLATE, base, live::Instrument::Drums)?,
    ])
}

/// The notated song as a Live set: sections become scenes (each with the tempo
/// prevailing at its start), and the tempo map becomes Arrangement automation.
fn song_set<'a>(song: &Song, blocks: &[&'a str]) -> live::Set<'a> {
    let sections = sections(song);
    let tempos = section_tempos(song, &sections);
    let tracks = song
        .tracks
        .iter()
        .map(|track| {
            let block = pick(blocks, family(&track.name, track.instrument, track.is_drums));
            let layout = crate::render::track_events(track);
            live_track(block, &track.name, &layout, song.time_signature, &sections)
        })
        .collect();
    live::Set { tempo: song.tempo, tempo_changes: tempo_changes(song), scenes: scenes(&sections, &tempos), tracks }
}

/// A flat, beat-based [`FlatSong`] as a Live set (raw MIDI: notes at absolute
/// beats, marker-derived sections, a single tempo). Reuses the same track
/// layout as the notated path; the only difference is that the layout comes
/// from flat notes rather than notated rhythm.
///
/// Trick that makes the reuse work: **one section == one "measure"**. We tag
/// each note with its section index as its `measure`, and build a
/// `measure_starts` grid from the section boundaries in beats. Then
/// [`live_track`] (which filters by `measure` and spans by `measure_starts`)
/// behaves exactly as it does for notated input.
fn flat_set<'a>(song: &crate::midi_read::FlatSong, blocks: &[&'a str]) -> live::Set<'a> {
    // Section index doubles as measure index; the beat grid is the section
    // boundaries plus the song end.
    let sections: Vec<Section> = song
        .sections
        .iter()
        .enumerate()
        .map(|(i, s)| Section { name: s.name.clone(), start: i, end: i + 1 })
        .collect();
    let measure_starts = flat_measure_starts(&song.sections);
    // Raw MIDI carries no reliable notated meter for a clip grid; 4/4 is the
    // safe default (it only affects the clip's displayed bar lines).
    let ts = TimeSignature::new(4, 4);
    let tracks = song
        .tracks
        .iter()
        .map(|track| {
            let block = pick(blocks, family(&track.name, 0, track.is_drums));
            let layout = flat_layout(track, &song.sections, &measure_starts);
            live_track(block, &track.name, &layout, ts, &sections)
        })
        .collect();
    // No tempo map in flat MIDI: one tempo, and every scene at it.
    let tempos = vec![song.tempo; sections.len()];
    live::Set { tempo: song.tempo, tempo_changes: Vec::new(), scenes: scenes(&sections, &tempos), tracks }
}

/// The template track closest to `fam` (drums by device, others by track
/// name), falling back to the first non-drum track.
fn pick<'a>(blocks: &[&'a str], fam: Family) -> &'a str {
    let is_drums = |b: &str| b.contains("<DrumGroupDevice");
    let fallback = blocks.iter().find(|b| !is_drums(b)).copied().unwrap_or(blocks[0]);
    blocks
        .iter()
        .find(|b| family(live::track_name(b), 0, is_drums(b)) == fam)
        .copied()
        .unwrap_or(fallback)
}

/// One track from a precomputed `(measure_starts, events)` layout: a Session
/// clip per section (clip times 0-based, empty sections get an empty slot) and
/// one Arrangement clip spanning the whole song, so pressing Play plays every
/// track together.
fn live_track<'a>(
    template: &'a str,
    name: &str,
    layout: &(Vec<f64>, Vec<Event>),
    ts: TimeSignature,
    sections: &[Section],
) -> live::Track<'a> {
    let (measure_starts, events) = layout;
    let time_sig = live::TimeSig { numerator: ts.numerator, denominator: ts.denominator };
    let session = sections
        .iter()
        .map(|section| {
            let (origin, length) = section_span(measure_starts, section);
            let notes: Vec<live::Note> = events
                .iter()
                .filter(|e| e.measure >= section.start && e.measure < section.end)
                .map(|e| note(e, origin))
                .collect();
            (!notes.is_empty()).then(|| live::Clip { name: section.name.clone(), start: 0.0, length, time_sig, notes })
        })
        .collect();
    let arrangement = live::Clip {
        name: name.to_string(),
        start: 0.0,
        length: measure_starts.last().copied().unwrap_or(0.0),
        time_sig,
        notes: events.iter().map(|e| note(e, 0.0)).collect(),
    };
    live::Track { template, name: name.to_string(), session, arrangement: Some(arrangement) }
}

/// A rendered event as a clip note, times relative to `origin`, with its
/// bend/slide/vibrato as a per-note pitch curve.
fn note(e: &Event, origin: f64) -> live::Note {
    live::Note {
        pitch: e.pitch,
        start: e.start - origin,
        dur: e.dur,
        velocity: e.velocity,
        pitch_curve: e.pitch_fx.map(|fx| pitch_curve(fx, e.dur)).unwrap_or_default(),
    }
}

/// One scene per section, at that section's tempo.
fn scenes(sections: &[Section], tempos: &[f64]) -> Vec<live::Scene> {
    sections
        .iter()
        .enumerate()
        .map(|(si, s)| live::Scene { name: s.name.clone(), tempo: tempos.get(si).copied().unwrap_or(120.0) })
        .collect()
}

/// `(beat, bpm)` at each measure where the tempo changes, for the Arrangement.
fn tempo_changes(song: &Song) -> Vec<(f64, f64)> {
    let reference = song.tracks.first();
    let measure_starts = reference.map(|t| crate::render::track_events(t).0).unwrap_or_default();
    let mut out = Vec::new();
    let mut current = song.tempo;
    let count = song.tracks.iter().map(|t| t.measures.len()).max().unwrap_or(0);
    for i in 0..count {
        if let Some(bpm) = song.tracks.iter().find_map(|t| t.measures.get(i).and_then(|m| m.tempo)) {
            if bpm != current {
                if let Some(&beat) = measure_starts.get(i) {
                    out.push((beat, bpm));
                }
            }
            current = bpm;
        }
    }
    out
}

/// Beat grid for a flat song: each section's start beat, then the song end, so
/// `measure_starts[i]` and `measure_starts[i+1]` bound section `i`.
fn flat_measure_starts(sections: &[crate::midi_read::FlatSection]) -> Vec<f64> {
    let mut v: Vec<f64> = sections.iter().map(|s| s.start).collect();
    let end = sections.last().map(|s| s.start + s.length).unwrap_or(0.0);
    v.push(end);
    v
}

/// A flat track's `(measure_starts, events)` layout: every note tagged with the
/// index of the section it starts in (its `measure`), times in absolute beats.
fn flat_layout(
    track: &crate::midi_read::FlatTrack,
    sections: &[crate::midi_read::FlatSection],
    measure_starts: &[f64],
) -> (Vec<f64>, Vec<Event>) {
    let events = track
        .notes
        .iter()
        .map(|n| Event {
            measure: section_index(sections, n.start),
            pitch: n.pitch,
            start: n.start,
            dur: n.dur,
            velocity: n.velocity,
            pitch_fx: None,
        })
        .collect();
    (measure_starts.to_vec(), events)
}

/// Index of the section a beat falls in: the last section whose start is at or
/// before it (sections are contiguous and cover the whole song).
fn section_index(sections: &[crate::midi_read::FlatSection], beat: f64) -> usize {
    let mut idx = 0;
    for (i, s) in sections.iter().enumerate() {
        if s.start <= beat + 1e-9 {
            idx = i;
        } else {
            break;
        }
    }
    idx
}

/// Instrument family, used to match a song part to a template track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    Drums,
    Bass,
    Guitar,
    Keys,
    Strings,
    Vocal,
    Other,
}

/// Classify by name keywords first (so a "Vocals" part on a viola patch maps to
/// the Vocal family), then fall back to the General MIDI program range.
fn family(name: &str, gm: u8, is_drums: bool) -> Family {
    if is_drums {
        return Family::Drums;
    }
    let n = name.to_lowercase();
    let has = |kws: &[&str]| kws.iter().any(|k| n.contains(k));
    // Guitar/bass before vocal so "Lead Guitar" stays a Guitar; "Lead" alone
    // (and named vocal parts) map to the Vocal/melody family.
    if has(&["bass"]) {
        Family::Bass
    } else if has(&["guitar", "gtr"]) {
        Family::Guitar
    } else if has(&["vocal", "voice", "vox", "sing", "choir", "lyric", "lead", "melody"]) {
        Family::Vocal
    } else if has(&["piano", "keys", "rhodes", "organ", "synth", "wurli", "clav"]) {
        Family::Keys
    } else if has(&["string", "violin", "viola", "cello", "orchestr", "ensemble"]) {
        Family::Strings
    } else {
        // Fall back to the GM program family.
        match gm {
            0..=23 => Family::Keys,
            24..=31 => Family::Guitar,
            32..=39 => Family::Bass,
            40..=51 => Family::Strings,
            _ => Family::Other,
        }
    }
}

/// A span of measures `[start, end)` that becomes one Session scene / clip row.
struct Section {
    name: String,
    start: usize,
    end: usize,
}

/// Derive sections from measure markers: a section starts at measure 0 and at
/// any measure carrying a marker (in any track). With no markers, the whole
/// song is one section.
fn sections(song: &Song) -> Vec<Section> {
    let measure_count = song.tracks.iter().map(|t| t.measures.len()).max().unwrap_or(0).max(1);
    let mut starts: Vec<usize> = vec![0];
    for i in 0..measure_count {
        let marked = song.tracks.iter().any(|t| t.measures.get(i).is_some_and(|m| m.marker.is_some()));
        if marked && !starts.contains(&i) {
            starts.push(i);
        }
    }
    starts.sort_unstable();

    starts
        .iter()
        .enumerate()
        .map(|(k, &start)| {
            let end = starts.get(k + 1).copied().unwrap_or(measure_count);
            let name = song
                .tracks
                .iter()
                .find_map(|t| t.measures.get(start).and_then(|m| m.marker.clone()))
                .unwrap_or_else(|| format!("Section {}", k + 1));
            Section { name, start, end }
        })
        .collect()
}

/// The prevailing tempo (BPM) at each section's start measure, carrying tempo
/// changes forward from the song's initial tempo.
fn section_tempos(song: &Song, sections: &[Section]) -> Vec<f64> {
    let measure_count = song.tracks.iter().map(|t| t.measures.len()).max().unwrap_or(0);
    let mut per_measure = Vec::with_capacity(measure_count);
    let mut current = song.tempo;
    for i in 0..measure_count {
        if let Some(bpm) = song.tracks.iter().find_map(|t| t.measures.get(i).and_then(|m| m.tempo)) {
            current = bpm;
        }
        per_measure.push(current);
    }
    sections
        .iter()
        .map(|s| per_measure.get(s.start).copied().unwrap_or(song.tempo))
        .collect()
}

/// Section beat-spans for the notes-JSON path (extension Session view): one
/// `(name, start_beat, length_beat)` per section. Mirrors the `.als` Session
/// layout so the extension can build the same per-section clips + scenes.
/// `measure_starts` is taken from the track with the most measures (the full
/// grid), since shorter tracks would truncate later sections.
pub(crate) fn section_spans_beats(song: &Song) -> Vec<(String, f64, f64)> {
    let secs = sections(song);
    let reference = song.tracks.iter().max_by_key(|t| t.measures.len());
    let measure_starts = reference.map(|t| crate::render::track_events(t).0).unwrap_or_default();
    if measure_starts.is_empty() {
        return Vec::new();
    }
    secs.iter()
        .map(|s| {
            let (start, length) = section_span(&measure_starts, s);
            (s.name.clone(), start, length)
        })
        .collect()
}

/// A section's absolute start beat and its length in beats.
fn section_span(measure_starts: &[f64], section: &Section) -> (f64, f64) {
    let last = measure_starts.len() - 1;
    let a = section.start.min(last);
    let b = section.end.min(last);
    let origin = measure_starts[a];
    (origin, (measure_starts[b] - origin).max(1.0))
}
