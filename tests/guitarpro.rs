//! Guitar Pro source: build a small song in code, write it with the
//! `guitarpro` crate as GP5, GP6 (.gpx) and GP7 (.gp), and read each back
//! through tabridge. Self-made fixtures, so no third-party tab files.

use guitarpro::audio::midi::MidiChannel;
use guitarpro::model::legacy::effects::{BendEffect, BendPoint};
use guitarpro::model::legacy::headers::Marker;
use guitarpro::model::legacy::mix_table::{MixTableChange, MixTableItem};
use guitarpro::{Beat, BendType, Measure, MeasureHeader, Note, NoteType, SlideType, Song, Track, Voice};

use tabridge::model::{Duration, TimeSignature};
use tabridge::sources::guitarpro::Format;
use tabridge::sources::GuitarPro;

const Q: i64 = 960; // ticks per quarter in the GP model

fn note(string: i8, fret: i16) -> Note {
    Note { string, value: fret, kind: NoteType::Normal, velocity: 95, ..Note::default() }
}

fn beat(value: u16, notes: Vec<Note>) -> Beat {
    let mut b = Beat::default();
    b.duration.value = value;
    b.notes = notes;
    b
}

fn measure(track_index: usize, header_index: usize, beats: Vec<Beat>) -> Measure {
    Measure {
        number: header_index + 1,
        start: Q + header_index as i64 * 4 * Q,
        track_index,
        header_index,
        voices: vec![Voice { beats, ..Voice::default() }, Voice::default()],
        ..Measure::default()
    }
}

/// Two 4/4 bars at 100 BPM, "Intro" marker on bar 1, 140 BPM from bar 2.
/// Guitar, standard tuning:
///   bar 1: E2 open (q), B4 = string 1 fret 7 bent a whole tone (q),
///          D3 = string 4 fret 0 with vibrato and a slide (dotted q), e rest
///   bar 2: three triplet eighths (A2, B2, C#3 on string 5), then a half note
/// Drums: a kick (GM 36) on every quarter.
fn build() -> Song {
    let mut song = Song { name: "Sample".into(), artist: "tabridge".into(), tempo: 100, ..Song::default() };
    // The GP5 writer expects the five lyric lines to exist.
    song.lyrics.lines = (0..5).map(|_| (0, 1, String::new())).collect();
    song.channels = (0..64u8)
        .map(|i| MidiChannel { channel: i, effect_channel: i, instrument: if i == 0 { 29 } else { 0 }, ..MidiChannel::default() })
        .collect();

    let mut h1 = MeasureHeader { number: 1, start: Q, tempo: 100, ..MeasureHeader::default() };
    h1.marker = Some(Marker { title: "Intro".into(), color: 0xff0000 });
    let h2 = MeasureHeader { number: 2, start: Q + 4 * Q, tempo: 140, ..MeasureHeader::default() };
    song.measure_headers = vec![h1, h2];

    // Guitar.
    let mut bent = note(1, 7);
    bent.effect.bend = Some(BendEffect {
        kind: BendType::Bend,
        value: 100,
        points: vec![
            BendPoint { position: 0, value: 0, vibrato: false },
            BendPoint { position: 6, value: 4, vibrato: false },
            BendPoint { position: 12, value: 4, vibrato: false },
        ],
        ..BendEffect::default()
    });
    let mut wobbly = note(4, 0);
    wobbly.effect.vibrato = true;
    wobbly.effect.slides = vec![SlideType::ShiftSlideTo];
    let mut dotted = beat(4, vec![wobbly]);
    dotted.duration.dotted = true;
    let mut rest = beat(8, vec![]);
    rest.status = guitarpro::BeatStatus::Rest;
    let bar1 = vec![beat(4, vec![note(6, 0)]), beat(4, vec![bent]), dotted, rest];

    let triplet = |fret| {
        let mut b = beat(8, vec![note(5, fret)]);
        b.duration.tuplet_enters = 3;
        b.duration.tuplet_times = 2;
        b
    };
    let mut bar2 = vec![triplet(0), triplet(2), triplet(4), beat(4, vec![note(5, 0)]), beat(4, vec![note(5, 0)])];
    // GP3-5 carry tempo changes as a mix-table event on a beat (GP6/7 use the
    // header's tempo automation, set on h2 above).
    bar2[0].effect.mix_table_change = Some(MixTableChange {
        tempo: Some(MixTableItem { value: 140, duration: 0, all_tracks: true }),
        ..MixTableChange::default()
    });

    let guitar = Track {
        number: 1,
        name: "Guitar".into(),
        channel_index: 0,
        measures: vec![measure(0, 0, bar1), measure(0, 1, bar2)],
        ..Track::default()
    };

    // Drums.
    let kicks = || (0..4).map(|_| beat(4, vec![note(1, 36)])).collect::<Vec<_>>();
    let drums = Track {
        number: 2,
        name: "Drums".into(),
        channel_index: 9,
        percussion_track: true,
        strings: vec![(1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0)],
        measures: vec![measure(1, 0, kicks()), measure(1, 1, kicks())],
        ..Track::default()
    };

    song.tracks = vec![guitar, drums];
    song
}

fn check(bytes: &[u8], expect: Format) {
    assert_eq!(GuitarPro::sniff(bytes), Some(expect), "format sniffed");
    let song = GuitarPro::new().parse(bytes).expect("parses");

    assert_eq!(song.title, "Sample");
    assert_eq!(song.tempo, 100.0);
    assert_eq!(song.time_signature, TimeSignature::new(4, 4));
    assert_eq!(song.tracks.len(), 2);

    let g = &song.tracks[0];
    assert_eq!(g.name, "Guitar");
    assert!(!g.is_drums);
    assert_eq!(g.tuning.0, vec![40, 45, 50, 55, 59, 64], "lowest string first");
    assert_eq!(g.measures.len(), 2);
    assert_eq!(g.measures[0].marker.as_deref(), Some("Intro"));
    assert_eq!(g.measures[1].tempo, Some(140.0), "tempo change on bar 2");

    let b1 = &g.measures[0].voices[0].beats;
    assert_eq!(b1[0].notes[0].pitch, 40, "open low E");
    assert_eq!(b1[1].notes[0].pitch, 71, "string 1 fret 7 = B4");
    assert_eq!(b1[1].notes[0].bend, Some(2.0), "whole-tone bend = 2 semitones");
    assert!(b1[1].notes[0].articulation.bend);
    let d3 = &b1[2].notes[0];
    assert_eq!(d3.pitch, 50);
    assert!(d3.articulation.vibrato && d3.articulation.slide);
    assert_eq!(b1[2].duration, Duration::new(4).dotted(1));
    assert!(b1[3].notes.is_empty(), "rest");

    let b2 = &g.measures[1].voices[0].beats;
    let pitches: Vec<u8> = b2.iter().take(3).map(|b| b.notes[0].pitch).collect();
    assert_eq!(pitches, vec![45, 47, 49]);
    assert_eq!(b2[0].duration, Duration::from_fraction(1, 12), "triplet eighth");

    let d = &song.tracks[1];
    assert!(d.is_drums);
    assert!(d.tuning.0.is_empty());
    let kicks: Vec<u8> = d.measures[0].voices[0].beats.iter().map(|b| b.notes[0].pitch).collect();
    assert_eq!(kicks, vec![36; 4], "GM kick");

    // And the whole pipeline downstream of the model runs.
    tabridge::midi::write_midi(&song).expect("midi");
    tabridge::als::write_als(&song).expect("als");
}

#[test]
fn reads_gp5() {
    let bytes = build().write((5, 0, 0), None).expect("write gp5");
    check(&bytes, Format::Gp5);
}

#[test]
fn reads_gp7() {
    let bytes = build().write_gp().expect("write gp7");
    check(&bytes, Format::Gp7);
}

#[test]
fn reads_gpx() {
    let bytes = build().write_gpx().expect("write gpx");
    check(&bytes, Format::Gpx);
}

/// GP3/GP4 carry fewer effects, so only check that they parse with the right
/// notes and tracks.
fn check_basic(bytes: &[u8], expect: Format) {
    assert_eq!(GuitarPro::sniff(bytes), Some(expect), "format sniffed");
    let song = GuitarPro::new().parse(bytes).expect("parses");
    assert_eq!(song.tracks.len(), 2);
    let b1 = &song.tracks[0].measures[0].voices[0].beats;
    assert_eq!(b1[0].notes[0].pitch, 40);
    assert_eq!(b1[1].notes[0].pitch, 71);
    assert!(song.tracks[1].is_drums);
    tabridge::als::write_als(&song).expect("als");
}

#[test]
fn reads_gp4() {
    let bytes = build().write((4, 0, 6), None).expect("write gp4");
    check_basic(&bytes, Format::Gp4);
}

#[test]
fn reads_gp3() {
    let bytes = build().write((3, 0, 0), None).expect("write gp3");
    check_basic(&bytes, Format::Gp3);
}

#[test]
fn rejects_non_guitar_pro_bytes() {
    assert_eq!(GuitarPro::sniff(b"MThd\0\0\0\x06"), None);
    assert!(GuitarPro::new().parse(b"<score-partwise/>").is_err());
}
