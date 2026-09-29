//! Run every Guitar Pro file in a folder through tabridge and report what came
//! out: format, tempo, tracks, notes, articulations, sections, and whether the
//! .mid and .als writers accept the result.
//!
//!     cargo run --example gp_report -- path/to/folder [notes]
//!
//! With `notes`, also prints each track's first 12 pitches.

use std::path::Path;

use tabridge::sources::GuitarPro;

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let show_notes = std::env::args().nth(2).as_deref() == Some("notes");
    let mut entries: Vec<_> = std::fs::read_dir(&dir).expect("read folder").flatten().map(|e| e.path()).collect();
    entries.sort();
    let (mut ok, mut failed) = (0, 0);
    for path in entries {
        if !is_gp(&path) {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy();
        let bytes = std::fs::read(&path).expect("read file");
        let format = GuitarPro::sniff(&bytes);
        match GuitarPro::new().parse(&bytes) {
            Err(e) => {
                failed += 1;
                println!("FAIL {name} ({format:?}): {e}");
            }
            Ok(song) => {
                let notes: Vec<_> = song
                    .tracks
                    .iter()
                    .flat_map(|t| &t.measures)
                    .flat_map(|m| &m.voices)
                    .flat_map(|v| &v.beats)
                    .flat_map(|b| &b.notes)
                    .collect();
                let bends: Vec<f32> = notes.iter().filter_map(|n| n.bend).collect();
                let count = |f: fn(&tabridge::model::Articulation) -> bool| notes.iter().filter(|n| f(&n.articulation)).count();
                let sections: Vec<&str> =
                    song.tracks.first().map(|t| t.measures.iter().filter_map(|m| m.marker.as_deref()).collect()).unwrap_or_default();
                let tempos = song.tracks.first().map(|t| t.measures.iter().filter(|m| m.tempo.is_some()).count()).unwrap_or(0);
                let midi = tabridge::midi::write_midi(&song).map(|b| b.len());
                let als = tabridge::als::write_als(&song).map(|b| b.len());
                let tracks: Vec<String> = song
                    .tracks
                    .iter()
                    .map(|t| format!("{}{}{:?}", t.name, if t.is_drums { " [drums] " } else { " " }, t.tuning.0))
                    .collect();
                let good = midi.is_ok() && als.is_ok();
                if good { ok += 1 } else { failed += 1 }
                println!(
                    "{} {name} ({format:?}) \"{}\" {} BPM, {} tempo changes | {} notes, bends {:?}, slides {}, vibrato {}, dead {}, ties {} | sections {:?} | tracks: {} | mid {:?} als {:?}",
                    if good { "OK  " } else { "FAIL" },
                    song.title,
                    song.tempo,
                    tempos,
                    notes.len(),
                    &bends[..bends.len().min(6)],
                    count(|a| a.slide),
                    count(|a| a.vibrato),
                    count(|a| a.dead),
                    notes.iter().filter(|n| n.tied).count(),
                    sections,
                    tracks.join("; "),
                    midi.map_err(|e| e.chars().take(60).collect::<String>()),
                    als.map_err(|e| e.chars().take(60).collect::<String>()),
                );
                if show_notes {
                    for t in &song.tracks {
                        let first: Vec<u8> = t
                            .measures
                            .iter()
                            .flat_map(|m| &m.voices)
                            .flat_map(|v| &v.beats)
                            .flat_map(|b| &b.notes)
                            .map(|n| n.pitch)
                            .take(12)
                            .collect();
                        println!("       {}: {:?}", t.name, first);
                    }
                }
            }
        }
    }
    println!("\n{ok} ok, {failed} failed");
}

fn is_gp(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("gp" | "gpx" | "gp3" | "gp4" | "gp5")
    )
}
