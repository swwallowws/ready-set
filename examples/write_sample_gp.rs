//! Write a tiny Guitar Pro 7 file (one guitar bar with a bend), for manual
//! and browser testing of the Guitar Pro import. Self-made, so free to share.
//!
//!     cargo run --example write_sample_gp -- out.gp

use guitarpro::audio::midi::MidiChannel;
use guitarpro::model::legacy::effects::{BendEffect, BendPoint};
use guitarpro::{Beat, BendType, Measure, MeasureHeader, Note, NoteType, Song, Track, Voice};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args().nth(1).unwrap_or_else(|| "sample.gp".into());

    let mut song = Song { name: "tabridge sample".into(), tempo: 96, ..Song::default() };
    song.channels = (0..64u8)
        .map(|i| MidiChannel { channel: i, effect_channel: i, instrument: if i == 0 { 29 } else { 0 }, ..MidiChannel::default() })
        .collect();
    song.measure_headers = vec![MeasureHeader { number: 1, start: 960, tempo: 96, ..MeasureHeader::default() }];

    let note = |string, fret| Note { string, value: fret, kind: NoteType::Normal, velocity: 95, ..Note::default() };
    let beat = |notes: Vec<Note>| Beat { notes, ..Beat::default() };
    let mut bent = note(2, 8);
    bent.effect.bend = Some(BendEffect {
        kind: BendType::Bend,
        value: 100,
        points: vec![
            BendPoint { position: 0, value: 0, vibrato: false },
            BendPoint { position: 12, value: 4, vibrato: false },
        ],
        ..BendEffect::default()
    });
    let beats = vec![beat(vec![note(6, 0)]), beat(vec![note(5, 2)]), beat(vec![note(4, 2)]), beat(vec![bent])];

    song.tracks = vec![Track {
        name: "Guitar".into(),
        measures: vec![Measure { voices: vec![Voice { beats, ..Voice::default() }, Voice::default()], ..Measure::default() }],
        ..Track::default()
    }];

    std::fs::write(&out, song.write_gp()?)?;
    println!("wrote {out}");
    Ok(())
}
