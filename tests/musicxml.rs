//! Parse a hand-written MusicXML document and assert the mapping: parts →
//! tracks, divisions-based durations, chords, rests, accidentals, time sig,
//! tempo, and that it emits a valid multi-track SMF.

use midly::Smf;
use tabridge::midi::write_midi;
use tabridge::model::Duration;
use tabridge::sources::MusicXml;

const XML: &str = include_str!("data/sample.musicxml");

#[test]
fn parses_score_partwise() {
    let song = MusicXml::new().parse(XML).expect("parse");

    assert_eq!(song.title, "Test Tune");
    assert_eq!(song.artist, "tabridge");
    assert_eq!(song.tempo, 90.0);
    assert_eq!(song.time_signature.numerator, 4);
    assert_eq!(song.tracks.len(), 2);

    // Track 0: Guitar (GM program 28 - 1 = 27), single voice, 4 beats.
    let guitar = &song.tracks[0];
    assert_eq!(guitar.name, "Guitar");
    assert_eq!(guitar.instrument, 27);
    assert!(!guitar.is_drums);
    let m0 = &guitar.measures[0];
    assert_eq!(m0.tempo, Some(90.0));
    assert_eq!(m0.voices.len(), 1);
    let beats = &m0.voices[0].beats;
    assert_eq!(beats.len(), 4);

    // Beat 0: C-major triad as a quarter (2/8 → 1/4).
    let chord: Vec<u8> = beats[0].notes.iter().map(|n| n.pitch).collect();
    assert_eq!(chord, vec![60, 64, 67]); // C4 E4 G4
    assert_eq!(beats[0].duration, Duration::new(4));

    // Beat 1: F#4 eighth (alter +1).
    assert_eq!(beats[1].notes[0].pitch, 66);
    assert_eq!(beats[1].duration, Duration::new(8));

    // Beat 2: an eighth rest with no notes; time still advances.
    assert!(beats[2].notes.is_empty());
    assert_eq!(beats[2].duration, Duration::new(8));

    // Beat 3: A4 half note (4/8 → 1/2).
    assert_eq!(beats[3].notes[0].pitch, 69);
    assert_eq!(beats[3].duration, Duration::new(2));

    // Track 1: Bass, a single whole note E2.
    let bass = &song.tracks[1];
    assert_eq!(bass.name, "Bass");
    assert_eq!(bass.instrument, 33);
    let bass_beat = &bass.measures[0].voices[0].beats[0];
    assert_eq!(bass_beat.notes[0].pitch, 40); // E2
    assert_eq!(bass_beat.duration, Duration::whole());
}

#[test]
fn emits_valid_midi() {
    let song = MusicXml::new().parse(XML).expect("parse");
    let bytes = write_midi(&song).expect("write");
    let smf = Smf::parse(&bytes).expect("parse back");
    // Conductor track + the two instrument tracks.
    assert_eq!(smf.tracks.len(), 3);
}
