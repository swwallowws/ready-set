//! The flat MIDI → .als path (raw MIDI without notated rhythm): build a
//! [`FlatSong`] by hand, render it, then gunzip and assert the generated Live
//! XML is well-formed and structurally parallel to the notated path: the
//! checks that predict whether Live will actually open the file.

use std::io::Read;

use flate2::read::GzDecoder;
use roxmltree::{Document, ParsingOptions};
use tabridge::als::{write_als_flat, write_als_flat_with_template};
use tabridge::midi_read::{FlatNote, FlatSection, FlatSong, FlatTrack};

fn gunzip(bytes: &[u8]) -> String {
    let mut s = String::new();
    GzDecoder::new(bytes).read_to_string(&mut s).expect("gunzip");
    s
}

fn parse(xml: &str) {
    assert!(xml.starts_with("<?xml"), "missing XML prolog");
    assert!(xml.contains("<Ableton "), "missing <Ableton>");
    let opts = ParsingOptions { allow_dtd: true, ..ParsingOptions::default() };
    Document::parse_with_options(xml, opts).expect("generated als is well-formed XML");
}

/// The largest `Id="N"` in the document.
fn max_id(s: &str) -> u64 {
    s.match_indices("Id=\"")
        .filter_map(|(i, _)| {
            let start = i + 4;
            let end = start + s[start..].find('"')?;
            s[start..end].parse::<u64>().ok()
        })
        .max()
        .unwrap_or(0)
}

/// The `Value` of the first `<NextPointeeId Value="N" />`.
fn next_pointee_id(s: &str) -> u64 {
    let anchor = "<NextPointeeId Value=\"";
    let p = s.find(anchor).expect("no NextPointeeId") + anchor.len();
    let end = p + s[p..].find('"').unwrap();
    s[p..end].parse().unwrap()
}

/// A two-note melodic line plus a drum hit, split across three named sections.
/// The lead's name carries XML-special characters to exercise escaping: a raw
/// `&` or `"` would make the whole file unparseable (and un-openable in Live).
fn sample() -> FlatSong {
    let lead: Vec<FlatNote> = (0..30)
        .map(|i| FlatNote { pitch: 60 + (i % 3) as u8, start: i as f64, dur: 0.5, velocity: 100 })
        .collect();
    let drums: Vec<FlatNote> = (0..30)
        .map(|i| FlatNote { pitch: 36, start: i as f64, dur: 0.25, velocity: 110 })
        .collect();
    FlatSong {
        tempo: 128.0,
        tracks: vec![
            FlatTrack { name: "Lead <Guitar> & \"Vox\"".into(), is_drums: false, notes: lead },
            FlatTrack { name: "Drums".into(), is_drums: true, notes: drums },
        ],
        sections: vec![
            FlatSection { name: "Intro".into(), start: 0.0, length: 10.0 },
            FlatSection { name: "Verse".into(), start: 10.0, length: 10.0 },
            FlatSection { name: "Chorus".into(), start: 20.0, length: 10.0 },
        ],
    }
}

#[test]
fn flat_als_is_well_formed_and_structurally_parallel() {
    let song = sample();
    let als = write_als_flat(&song).expect("write flat als");
    assert_eq!(&als[..2], &[0x1f, 0x8b], "not gzip");

    let xml = gunzip(&als);
    parse(&xml);

    // One MidiTrack per flat track.
    assert_eq!(xml.matches("<MidiTrack ").count(), song.tracks.len());

    // One Scene per section, named after the sections.
    assert_eq!(xml.matches("<Scene ").count(), song.sections.len());
    for name in ["Intro", "Verse", "Chorus"] {
        assert!(xml.contains(&format!("<Name Value=\"{name}\" />")), "missing scene {name}");
    }

    // Each note lands once in its Session clip and once on the Arrangement
    // timeline: total MidiNoteEvents == 2 x note count, none dropped or duplicated.
    let notes: usize = song.tracks.iter().map(|t| t.notes.len()).sum();
    assert_eq!(xml.matches("<MidiNoteEvent ").count(), 2 * notes);

    // Per track: 3 Session clips (one per section) + 1 Arrangement clip.
    assert_eq!(xml.matches("<MidiClip ").count(), song.tracks.len() * (song.sections.len() + 1));

    // NextPointeeId must exceed every Id in the document, or Live rejects the set.
    assert!(next_pointee_id(&xml) > max_id(&xml), "NextPointeeId not above max Id");

    // The special characters survived as escaped entities (never raw).
    assert!(xml.contains("Lead &lt;Guitar&gt; &amp; &quot;Vox&quot;"), "name not escaped");
    assert!(!xml.contains("Lead <Guitar> & \"Vox\""), "raw special chars leaked into XML");
}

#[test]
fn built_in_template_puts_a_stock_instrument_on_every_track() {
    // Downloads should play as soon as they open: the drum part gets a Drum
    // Rack, the pitched part Tension (Live's StringStudio device).
    let xml = gunzip(&write_als_flat(&sample()).expect("write"));
    parse(&xml);
    let tracks: Vec<&str> = xml.split("<MidiTrack ").skip(1).collect();
    assert_eq!(tracks.len(), 2);
    let (lead, drums) = (tracks[0], tracks[1]);
    assert!(lead.contains("<StringStudio "), "no Tension on the pitched track");
    assert!(!lead.contains("<DrumGroupDevice"), "Drum Rack on the pitched track");
    assert!(drums.contains("<DrumGroupDevice"), "no Drum Rack on the drum track");
    assert!(!drums.contains("<StringStudio "), "Tension on the drum track");
    assert!(!xml.contains("/Users/"), "a home-folder path leaked into the set");
    assert!(next_pointee_id(&xml) > max_id(&xml), "NextPointeeId not above max Id");
}

#[test]
fn flat_als_with_real_template_is_well_formed() {
    // The same base template the notated path clones; the flat path must produce
    // an equally valid set from it.
    let template = expressive_liveset::TEMPLATE;
    let als = write_als_flat_with_template(&sample(), template).expect("write with template");
    let xml = gunzip(&als);
    parse(&xml);
    assert!(next_pointee_id(&xml) > max_id(&xml));
}

#[test]
fn flat_als_handles_a_single_unmarked_section() {
    // A MIDI file with no markers collapses to one whole-song section.
    let song = FlatSong {
        tempo: 120.0,
        tracks: vec![FlatTrack {
            name: "Piano".into(),
            is_drums: false,
            notes: vec![FlatNote { pitch: 64, start: 0.0, dur: 1.0, velocity: 90 }],
        }],
        sections: vec![FlatSection { name: "Song".into(), start: 0.0, length: 4.0 }],
    };
    let xml = gunzip(&write_als_flat(&song).expect("write"));
    parse(&xml);
    assert_eq!(xml.matches("<Scene ").count(), 1);
    // 1 Session clip + 1 Arrangement clip for the one note.
    assert_eq!(xml.matches("<MidiNoteEvent ").count(), 2);
}
