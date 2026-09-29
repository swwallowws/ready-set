//! Guitar Pro source (SPEC §11 / milestone 7): GP3, GP4, GP5, GP6 (`.gpx`)
//! and GP7+ (`.gp`), read with the `guitarpro` crate.
//!
//! Like MusicXML, a Guitar Pro file is self-contained, so this source just
//! parses bytes: no network, no manifest. The format is sniffed from the
//! bytes, not the file name.
//!
//! Mapping into the model:
//! * each GP track → a [`Track`] (name, GM program from its MIDI channel,
//!   percussion flag, open-string tuning lowest string first);
//! * GP measure headers carry the time signature, tempo and section marker,
//!   emitted on a [`Measure`] only where they change (markers wherever set);
//! * GP beats keep their voices; durations fold dots and tuplets into the
//!   whole-note fraction;
//! * pitch is the string's open pitch plus the fret, plus the capo on pitched
//!   tracks. Percussion tracks store the GM drum note directly.
//! * articulations: bends (target in semitones; GP bend points are quarter
//!   tones), slides, hammer-ons, harmonics, palm mutes, dead/ghost notes,
//!   staccato, accents and vibrato.

use guitarpro::model::legacy::effects::BendEffect;
use guitarpro::{BeatStatus, NoteType};

use super::{Http, Source, SourceError};
use crate::model::{Articulation, Beat, Duration, Measure, Note, Song, TimeSignature, Track, Tuning, Voice};

/// The Guitar Pro adapter.
#[derive(Debug, Default, Clone, Copy)]
pub struct GuitarPro;

/// Which Guitar Pro container a byte buffer holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Gp3,
    Gp4,
    Gp5,
    /// Guitar Pro 6 (`.gpx`, a BCFZ/BCFS container).
    Gpx,
    /// Guitar Pro 7+ (`.gp`, a zip holding `Content/score.gpif`).
    Gp7,
}

impl GuitarPro {
    pub fn new() -> Self {
        GuitarPro
    }

    /// Detect the Guitar Pro format from the first bytes, or `None` if these
    /// aren't Guitar Pro bytes.
    pub fn sniff(bytes: &[u8]) -> Option<Format> {
        if bytes.starts_with(b"PK\x03\x04") {
            return Some(Format::Gp7);
        }
        if bytes.starts_with(b"BCFZ") || bytes.starts_with(b"BCFS") {
            return Some(Format::Gpx);
        }
        // GP3-5 open with a length-prefixed 30-byte version string, e.g.
        // "FICHIER GUITAR PRO v5.00".
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(31)]);
        if !head.contains("GUITAR PRO") {
            return None;
        }
        if head.contains("v5") {
            Some(Format::Gp5)
        } else if head.contains("v4") {
            Some(Format::Gp4)
        } else if head.contains("v3") {
            Some(Format::Gp3)
        } else {
            None
        }
    }

    /// Parse Guitar Pro file bytes into a [`Song`].
    pub fn parse(&self, bytes: &[u8]) -> Result<Song, SourceError> {
        let format = Self::sniff(bytes).ok_or_else(|| {
            SourceError::UnrecognizedInput("not a Guitar Pro file (GP3, GP4, GP5, .gpx or .gp)".into())
        })?;
        let mut gp = guitarpro::Song::default();
        let read = match format {
            Format::Gp3 => gp.read_gp3(bytes),
            Format::Gp4 => gp.read_gp4(bytes),
            Format::Gp5 => gp.read_gp5(bytes),
            Format::Gpx => gp.read_gpx(bytes),
            Format::Gp7 => gp.read_gp(bytes),
        };
        read.map_err(|e| SourceError::Parse(format!("Guitar Pro ({format:?}): {e}")))?;
        Ok(convert(&gp))
    }
}

impl Source for GuitarPro {
    /// Load from raw Guitar Pro bytes carried in a `&str` is not possible (the
    /// formats are binary), so `input` must be a URL fetched via `http`. Use
    /// [`GuitarPro::parse`] for bytes you already have.
    fn load(&self, input: &str, http: &dyn Http) -> Result<Song, SourceError> {
        let trimmed = input.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            self.parse(&http.get(trimmed)?)
        } else {
            Err(SourceError::UnrecognizedInput(
                "Guitar Pro files are binary: pass the bytes to GuitarPro::parse, or a URL".into(),
            ))
        }
    }
}

fn convert(gp: &guitarpro::Song) -> Song {
    let headers = &gp.measure_headers;
    let time_signature = headers.first().map(|h| time_sig(&h.time_signature)).unwrap_or_default();
    let tempo = if gp.tempo > 0 { f64::from(gp.tempo) } else { 120.0 };

    let tracks = gp.tracks.iter().map(|t| convert_track(gp, t, tempo, time_signature)).collect();

    Song {
        title: gp.name.trim().to_string(),
        artist: gp.artist.trim().to_string(),
        tempo,
        time_signature,
        tracks,
    }
}

fn convert_track(gp: &guitarpro::Song, t: &guitarpro::Track, song_tempo: f64, song_ts: TimeSignature) -> Track {
    let is_drums = t.percussion_track;
    // The model wants the lowest string first. GP3-5 number strings from the
    // highest, GP6/7 from the lowest, so order by pitch instead of number.
    let mut open: Vec<u8> = t.strings.iter().map(|(_, p)| (*p).clamp(0, 127) as u8).collect();
    open.sort_unstable();
    let tuning = if is_drums { Tuning::default() } else { Tuning(open) };
    let capo = if is_drums { 0 } else { t.offset };
    let program = gp
        .channels
        .get(t.channel_index)
        .map(|c| c.instrument)
        .or(t.midi_program_gpif)
        .unwrap_or(0)
        .clamp(0, 127) as u8;

    let mut prev_tempo = song_tempo;
    let mut prev_ts = song_ts;
    let measures = t
        .measures
        .iter()
        .enumerate()
        .map(|(i, m)| {
            // A track's measures line up with the headers by position. (The
            // GP6/7 importer leaves `header_index` at 0, so it can't be used.)
            let header = gp.measure_headers.get(i);
            let ts = header.map(|h| time_sig(&h.time_signature)).unwrap_or(prev_ts);
            let time_signature = (i > 0 && ts != prev_ts).then_some(ts);
            prev_ts = ts;

            // Tempo: a mid-measure mix-table change wins, else the header's.
            let mix_tempo = m
                .voices
                .iter()
                .flat_map(|v| v.beats.iter())
                .find_map(|b| b.effect.mix_table_change.as_ref().and_then(|c| c.tempo.as_ref()))
                .map(|item| f64::from(item.value));
            let header_tempo = header.map(|h| f64::from(h.tempo)).filter(|t| *t > 0.0);
            let tempo_here = mix_tempo.or(header_tempo).unwrap_or(prev_tempo);
            let tempo = ((tempo_here - prev_tempo).abs() > 1e-6).then_some(tempo_here);
            prev_tempo = tempo_here;

            // GP5 marker titles can keep their length byte as a control
            // character ("\u{5}Intro"), so drop control characters.
            let marker = header
                .and_then(|h| h.marker.as_ref())
                .map(|mk| mk.title.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string())
                .filter(|s| !s.is_empty());

            let voices = m
                .voices
                .iter()
                .map(|v| Voice { beats: v.beats.iter().map(|b| convert_beat(b, &t.strings, capo, is_drums)).collect() })
                .filter(|v: &Voice| !v.beats.is_empty())
                .collect();

            Measure { voices, time_signature, tempo, marker }
        })
        .collect();

    Track { name: t.name.trim().to_string(), instrument: program, tuning, is_drums, measures }
}

fn convert_beat(b: &guitarpro::Beat, strings: &[(i8, i8)], capo: i32, is_drums: bool) -> Beat {
    let d = &b.duration;
    let dots = if d.double_dotted { 2 } else if d.dotted { 1 } else { 0 };
    let mut duration = Duration::new(u32::from(d.value.max(1))).dotted(dots);
    if d.tuplet_enters > 1 && d.tuplet_times > 0 && d.tuplet_enters != d.tuplet_times {
        duration = duration.tuplet(u32::from(d.tuplet_enters), u32::from(d.tuplet_times));
    }

    let notes = if b.status == BeatStatus::Normal {
        b.notes.iter().filter_map(|n| convert_note(n, b, strings, capo, is_drums)).collect()
    } else {
        Vec::new() // rest or empty beat: time passes, nothing sounds
    };
    Beat { duration, notes }
}

fn convert_note(
    n: &guitarpro::Note,
    beat: &guitarpro::Beat,
    strings: &[(i8, i8)],
    capo: i32,
    is_drums: bool,
) -> Option<Note> {
    if n.kind == NoteType::Rest {
        return None;
    }
    let pitch = if is_drums {
        // Percussion notes store the GM drum note itself.
        i32::from(n.value)
    } else {
        let open = if n.string > 0 {
            strings.iter().find(|(num, _)| *num == n.string).map(|(_, p)| i32::from(*p)).unwrap_or(0)
        } else {
            0
        };
        open + i32::from(n.value) + capo
    }
    .clamp(0, 127) as u8;

    let e = &n.effect;
    let articulation = Articulation {
        bend: e.bend.is_some(),
        slide: !e.slides.is_empty(),
        hammer_on: e.hammer,
        pull_off: false, // GP marks hammer-on and pull-off with one flag
        harmonic: e.harmonic.is_some(),
        palm_mute: e.palm_mute,
        dead: n.kind == NoteType::Dead,
        ghost: e.ghost_note,
        staccato: e.staccato,
        accent: e.accentuated_note || e.heavy_accentuated_note,
        vibrato: e.vibrato || beat.effect.vibrato,
    };
    let velocity = i32::from(n.velocity).clamp(1, 127) as u8;

    Some(Note {
        pitch,
        velocity,
        bend: e.bend.as_ref().and_then(bend_semitones),
        articulation,
        tied: n.kind == NoteType::Tie,
    })
}

/// The highest point of a bend, in semitones, or `None` for a flat line.
/// GP bend points are in quarter tones (4 = a whole tone), scaled by the
/// effect's `semitone_length`.
fn bend_semitones(b: &BendEffect) -> Option<f32> {
    let per_quarter_tone = 0.5 / f32::from(b.semitone_length.max(1));
    let top = b.points.iter().map(|p| f32::from(p.value)).fold(0.0_f32, f32::max);
    (top > 0.0).then_some(top * per_quarter_tone)
}

fn time_sig(ts: &guitarpro::TimeSignature) -> TimeSignature {
    TimeSignature::new(ts.numerator.max(1) as u8, ts.denominator.value.clamp(1, 255) as u8)
}
