//! The .als exporter: parse MusicXML → Song → .als, then gunzip and assert the
//! generated Ableton XML is well-formed and carries our tracks/notes.

use std::io::Read;

use flate2::read::GzDecoder;
use roxmltree::{Document, ParsingOptions};
use tabridge::als::write_als;
use tabridge::sources::MusicXml;

const XML: &str = include_str!("data/sample.musicxml");

fn gunzip(bytes: &[u8]) -> String {
    let mut s = String::new();
    GzDecoder::new(bytes).read_to_string(&mut s).expect("gunzip");
    s
}

#[test]
fn emits_valid_als_with_tracks_and_notes() {
    let song = MusicXml::new().parse(XML).expect("parse musicxml");
    let als = write_als(&song).expect("write als");

    // Round-trips through gzip and is well-formed XML (with the MusicXML/Live DTD allowed).
    let xml = gunzip(&als);
    assert!(xml.starts_with("<?xml"));
    assert!(xml.contains("<Ableton "));
    let opts = ParsingOptions { allow_dtd: true, ..ParsingOptions::default() };
    Document::parse_with_options(&xml, opts).expect("generated als is valid XML");

    // One MidiTrack per instrument, named.
    assert_eq!(xml.matches("<MidiTrack ").count(), song.tracks.len());
    assert!(xml.contains("<EffectiveName Value=\"Guitar\" />"));
    assert!(xml.contains("<EffectiveName Value=\"Bass\" />"));

    // Every sounding note becomes a MidiNoteEvent: once in its Session clip and
    // once on the Arrangement timeline (single-section fixture, both populated).
    let total_notes: usize = song
        .tracks
        .iter()
        .flat_map(|t| &t.measures)
        .flat_map(|m| &m.voices)
        .flat_map(|v| &v.beats)
        .map(|b| b.notes.len())
        .sum();
    assert_eq!(xml.matches("<MidiNoteEvent ").count(), 2 * total_notes);
    // Both views are present: Session clip slots + a populated Arrangement.
    assert!(xml.contains("<Events>"), "arrangement events present");

    // C4/E4/G4 from the guitar chord land as MidiKey values.
    for key in ["<MidiKey Value=\"60\" />", "<MidiKey Value=\"64\" />", "<MidiKey Value=\"67\" />"] {
        assert!(xml.contains(key), "missing {key}");
    }
}
