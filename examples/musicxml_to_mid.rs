//! MusicXML file → `.mid`. Pure (no network).
//!
//! Usage:
//!     cargo run --example musicxml_to_mid -- IN.musicxml [OUT.mid] [--semitones N]

use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut in_path = None;
    let mut out_path = "out.mid".to_string();
    let mut semitones = 0i32;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--semitones" => semitones = args.next().ok_or("--semitones needs a value")?.parse()?,
            _ if in_path.is_none() => in_path = Some(arg),
            _ => out_path = arg,
        }
    }
    let in_path = in_path.ok_or("usage: IN.musicxml [OUT.mid] [--semitones N]")?;

    let xml = fs::read_to_string(&in_path)?;
    let bytes = tabridge::musicxml_to_midi(&xml, semitones)?;
    fs::write(&out_path, &bytes)?;
    println!("wrote {out_path} ({} bytes)", bytes.len());
    Ok(())
}
