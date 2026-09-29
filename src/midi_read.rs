//! Read a Standard MIDI File into the flat notes-JSON the Ableton extension and
//! the in-browser preview consume.
//!
//! MIDI is raw tick timing with no bars or note-values, so rather than force it
//! through the score model (which would need a lossy transcriber/quantizer) we
//! emit flat `{pitch, start, dur, velocity}` in **beats** straight from the note
//! on/off events. This is lossless for playback, for the extension's Live Object
//! Model route, and for the flat `.als` writer (`als::write_als_flat`), which
//! places notes at their absolute beats instead of needing notated bars.
//!
//! Notes are bucketed by `(track, channel)` so General-MIDI percussion (channel
//! 10, zero-indexed 9) lands on its own drum track. Section markers, if present,
//! become the Session-view sections; otherwise the whole song is one section.

use std::collections::HashMap;

use midly::{num::u7, MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};

const DRUM_CHANNEL: u8 = 9;

/// Transpose a Standard MIDI File by `semitones`, shifting note on/off keys on
/// every non-drum channel (channel 10 / GM percussion is left alone) and
/// re-serializing. Returns the bytes unchanged when `semitones` is 0. Lets the
/// web preview/download reflect the Transpose control for MIDI sources without
/// going through the score model.
pub fn midi_transpose(bytes: &[u8], semitones: i32) -> Result<Vec<u8>, String> {
    if semitones == 0 {
        return Ok(bytes.to_vec());
    }
    let mut smf = Smf::parse(bytes).map_err(|e| format!("could not read MIDI: {e}"))?;
    for track in smf.tracks.iter_mut() {
        for ev in track.iter_mut() {
            if let TrackEventKind::Midi { channel, message } = &mut ev.kind {
                if channel.as_int() == DRUM_CHANNEL {
                    continue;
                }
                let key = match message {
                    MidiMessage::NoteOn { key, .. } | MidiMessage::NoteOff { key, .. } => key,
                    _ => continue,
                };
                *key = u7::new((key.as_int() as i32 + semitones).clamp(0, 127) as u8);
            }
        }
    }
    let mut buf = Vec::new();
    smf.write_std(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

pub struct FlatNote {
    pub pitch: u8,
    pub start: f64,
    pub dur: f64,
    pub velocity: u8,
}

pub struct FlatTrack {
    pub name: String,
    pub is_drums: bool,
    pub notes: Vec<FlatNote>,
}

pub struct FlatSection {
    pub name: String,
    pub start: f64,
    pub length: f64,
}

/// A whole MIDI file flattened to beats: one tempo, a set of note tracks, and
/// the marker-derived section spans. This is the shared shape both the
/// notes-JSON (previews) and the `.als` builder read from.
pub struct FlatSong {
    pub tempo: f64,
    pub tracks: Vec<FlatTrack>,
    pub sections: Vec<FlatSection>,
}

/// Parse a Standard MIDI File to the notes-JSON shape
/// (`{ tempo, tracks:[{name,isDrums,notes}], sections }`, times in beats),
/// applying an optional transpose to the non-drum tracks.
pub fn midi_to_notes_json(bytes: &[u8], semitones: i32) -> Result<String, String> {
    let song = parse_midi(bytes, semitones)?;
    let tracks_json: Vec<serde_json::Value> = song
        .tracks
        .iter()
        .map(|t| {
            let notes: Vec<serde_json::Value> = t
                .notes
                .iter()
                .map(|n| serde_json::json!({ "pitch": n.pitch, "start": n.start, "dur": n.dur, "velocity": n.velocity }))
                .collect();
            serde_json::json!({ "name": t.name, "isDrums": t.is_drums, "notes": notes })
        })
        .collect();
    let sections_json: Vec<serde_json::Value> = song
        .sections
        .iter()
        .map(|s| serde_json::json!({ "name": s.name, "start": s.start, "length": s.length }))
        .collect();
    serde_json::to_string(&serde_json::json!({
        "tempo": song.tempo,
        "tracks": tracks_json,
        "sections": sections_json,
    }))
    .map_err(|e| e.to_string())
}

/// Parse a Standard MIDI File into a flat, beat-based [`FlatSong`], applying an
/// optional transpose to the non-drum tracks (drums keep their GM numbers).
pub fn parse_midi(bytes: &[u8], semitones: i32) -> Result<FlatSong, String> {
    let smf = Smf::parse(bytes).map_err(|e| format!("could not read MIDI: {e}"))?;

    let tpq = match smf.header.timing {
        Timing::Metrical(t) => {
            let v = t.as_int() as f64;
            if v > 0.0 { v } else { 480.0 }
        }
        // SMPTE timing maps ticks to wall-clock seconds, not beats; without a
        // tempo map we can't place notes on a beat grid reliably.
        Timing::Timecode(..) => return Err("SMPTE-timed MIDI is not supported".into()),
    };

    let mut tempo_bpm = 120.0_f64;
    let mut tempo_tick = u64::MAX; // earliest tempo wins
    let mut markers: Vec<(u64, String)> = Vec::new();
    let mut tracks: Vec<FlatTrack> = Vec::new();

    for mtrk in smf.tracks.iter() {
        let mut abs: u64 = 0;
        let mut mtrk_name = String::new();
        // Notes still sounding: (channel, key) -> (start_tick, velocity).
        let mut active: HashMap<(u8, u8), (u64, u8)> = HashMap::new();
        // Finished notes bucketed by channel, in first-seen channel order.
        let mut by_channel: Vec<(u8, Vec<FlatNote>)> = Vec::new();

        let mut push_note = |ch: u8, n: FlatNote, order: &mut Vec<(u8, Vec<FlatNote>)>| {
            match order.iter_mut().find(|(c, _)| *c == ch) {
                Some((_, v)) => v.push(n),
                None => order.push((ch, vec![n])),
            }
        };

        for ev in mtrk.iter() {
            abs += ev.delta.as_int() as u64;
            match ev.kind {
                TrackEventKind::Meta(MetaMessage::TrackName(b)) => {
                    if mtrk_name.is_empty() {
                        mtrk_name = String::from_utf8_lossy(b).trim().to_string();
                    }
                }
                TrackEventKind::Meta(MetaMessage::Marker(b)) => {
                    markers.push((abs, String::from_utf8_lossy(b).trim().to_string()));
                }
                TrackEventKind::Meta(MetaMessage::Tempo(us)) => {
                    if abs < tempo_tick {
                        tempo_tick = abs;
                        let us = us.as_int() as f64;
                        if us > 0.0 {
                            tempo_bpm = 60_000_000.0 / us;
                        }
                    }
                }
                TrackEventKind::Midi { channel, message } => {
                    let ch = channel.as_int();
                    match message {
                        MidiMessage::NoteOn { key, vel } => {
                            let (k, v) = (key.as_int(), vel.as_int());
                            if v == 0 {
                                close_note(&mut active, ch, k, abs, tpq, &mut by_channel, &mut push_note);
                            } else {
                                active.insert((ch, k), (abs, v));
                            }
                        }
                        MidiMessage::NoteOff { key, .. } => {
                            close_note(&mut active, ch, key.as_int(), abs, tpq, &mut by_channel, &mut push_note);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        // Any notes still open at end of track: close them with a small tail.
        let leftovers: Vec<((u8, u8), (u64, u8))> = active.drain().collect();
        for ((ch, k), (start_tick, v)) in leftovers {
            let n = FlatNote { pitch: k, start: start_tick as f64 / tpq, dur: 0.25, velocity: v };
            push_note(ch, n, &mut by_channel);
        }

        let multi = by_channel.len() > 1;
        for (ch, notes) in by_channel {
            if notes.is_empty() {
                continue;
            }
            let is_drums = ch == DRUM_CHANNEL;
            let name = match (mtrk_name.is_empty(), multi) {
                (false, false) => mtrk_name.clone(),
                (false, true) => format!("{mtrk_name} (ch {})", ch + 1),
                (true, _) if is_drums => "Drums".to_string(),
                (true, _) => format!("Channel {}", ch + 1),
            };
            tracks.push(FlatTrack { name, is_drums, notes });
        }
    }

    if tracks.is_empty() {
        return Err("MIDI file has no notes".into());
    }

    // Transpose non-drum tracks (drums stay at their GM percussion numbers).
    if semitones != 0 {
        for t in tracks.iter_mut() {
            if t.is_drums {
                continue;
            }
            for n in t.notes.iter_mut() {
                n.pitch = (n.pitch as i32 + semitones).clamp(0, 127) as u8;
            }
        }
    }

    let song_end = tracks
        .iter()
        .flat_map(|t| t.notes.iter())
        .map(|n| n.start + n.dur)
        .fold(0.0_f64, f64::max)
        .max(1.0);

    let sections = build_sections(&markers, tpq, song_end);

    Ok(FlatSong { tempo: tempo_bpm, tracks, sections })
}

/// Move a sounding note into its channel bucket when its note-off arrives.
fn close_note<F>(
    active: &mut HashMap<(u8, u8), (u64, u8)>,
    ch: u8,
    key: u8,
    off_tick: u64,
    tpq: f64,
    order: &mut Vec<(u8, Vec<FlatNote>)>,
    push: &mut F,
) where
    F: FnMut(u8, FlatNote, &mut Vec<(u8, Vec<FlatNote>)>),
{
    if let Some((start_tick, vel)) = active.remove(&(ch, key)) {
        let start = start_tick as f64 / tpq;
        let dur = ((off_tick.saturating_sub(start_tick)) as f64 / tpq).max(1.0 / 32.0);
        push(ch, FlatNote { pitch: key, start, dur, velocity: vel }, order);
    }
}

/// Sections from MIDI marker meta-events (name + start beat), or one whole-song
/// section if the file has no markers. Times are in beats.
fn build_sections(markers: &[(u64, String)], tpq: f64, song_end: f64) -> Vec<FlatSection> {
    if markers.is_empty() {
        return vec![FlatSection { name: "Song".to_string(), start: 0.0, length: song_end }];
    }
    // Sort by tick, ensure a boundary at 0, drop duplicates.
    let mut pts: Vec<(f64, String)> = markers
        .iter()
        .map(|(tick, name)| (*tick as f64 / tpq, name.clone()))
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    if pts.first().map(|(b, _)| *b > 0.0).unwrap_or(true) {
        pts.insert(0, (0.0, "Intro".to_string()));
    }
    let mut out = Vec::with_capacity(pts.len());
    for i in 0..pts.len() {
        let start = pts[i].0;
        let end = pts.get(i + 1).map(|(b, _)| *b).unwrap_or(song_end);
        let length = (end - start).max(1.0 / 32.0);
        let name = if pts[i].1.is_empty() { format!("Section {}", i + 1) } else { pts[i].1.clone() };
        out.push(FlatSection { name, start, length });
    }
    out
}
