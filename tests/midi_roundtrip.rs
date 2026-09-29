//! Build a tiny song by hand and confirm it renders to a parseable SMF with
//! the expected pitches. Exercises the real `midi.rs` math (the rest of the
//! pipeline is still stubbed).

use midly::{MidiMessage, Smf, TrackEventKind};
use tabridge::midi::write_midi;
use tabridge::model::{Beat, Duration, Measure, Note, Song, TimeSignature, Track, Tuning, Voice};

fn note(pitch: u8) -> Note {
    Note { pitch, velocity: 100, bend: None, articulation: Default::default(), tied: false }
}

fn sample_song() -> Song {
    // Two quarter notes: low E (E2 = 40), then A2 = 45.
    let beats = vec![
        Beat { duration: Duration::new(4), notes: vec![note(40)] },
        Beat { duration: Duration::new(4), notes: vec![note(45)] },
    ];
    Song {
        title: "Test".into(),
        artist: "Test".into(),
        tempo: 120.0,
        time_signature: TimeSignature::new(4, 4),
        tracks: vec![Track {
            name: "Guitar".into(),
            instrument: 25,
            tuning: Tuning::standard_guitar(),
            is_drums: false,
            measures: vec![Measure {
                voices: vec![Voice { beats }],
                time_signature: None,
                tempo: None,
                marker: None,
            }],
        }],
    }
}

#[test]
fn renders_expected_pitches() {
    let bytes = write_midi(&sample_song()).expect("write");
    let smf = Smf::parse(&bytes).expect("parse back");

    // Conductor track + one instrument track.
    assert_eq!(smf.tracks.len(), 2);

    let keys: Vec<u8> = smf.tracks[1]
        .iter()
        .filter_map(|ev| match ev.kind {
            TrackEventKind::Midi { message: MidiMessage::NoteOn { key, vel }, .. } if vel > 0 => {
                Some(key.as_int())
            }
            _ => None,
        })
        .collect();

    assert_eq!(keys, vec![40, 45]);
}
