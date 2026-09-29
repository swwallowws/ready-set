//! MusicXML file → Ableton `.als` project. Pure (no network).
//!
//! Usage:
//!     cargo run --example musicxml_to_als -- IN.musicxml [OUT.als] [--semitones N] [--template SET.als]
//!
//! `--template` clones tracks (instruments, devices, mappings) from a gunzipped
//! Live set's first melodic track and its Drum Rack track. Without it, a
//! minimal built-in template (named tracks + notes, no instruments) is used.

use std::fs;
use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut in_path = None;
    let mut out_path = "out.als".to_string();
    let mut semitones = 0i32;
    let mut template_path = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--semitones" => semitones = args.next().ok_or("--semitones needs a value")?.parse()?,
            "--template" => template_path = Some(args.next().ok_or("--template needs a path")?),
            _ if in_path.is_none() => in_path = Some(arg),
            _ => out_path = arg,
        }
    }
    let in_path = in_path.ok_or("usage: IN.musicxml [OUT.als] [--semitones N] [--template SET.als]")?;
    let xml = fs::read_to_string(&in_path)?;

    let bytes = match template_path {
        Some(path) => {
            let template = read_template(&path)?;
            tabridge::musicxml_to_als_with_template(&xml, semitones, &template)?
        }
        None => tabridge::musicxml_to_als(&xml, semitones)?,
    };
    fs::write(&out_path, &bytes)?;
    println!("wrote {out_path} ({} bytes gzipped)", bytes.len());
    Ok(())
}

/// Read a template: a gunzipped `.als`, or already-decompressed `.xml`.
fn read_template(path: &str) -> Result<String, Box<dyn std::error::Error>> {
    let raw = fs::read(path)?;
    if raw.starts_with(&[0x1f, 0x8b]) {
        let mut s = String::new();
        flate2::read::GzDecoder::new(&raw[..]).read_to_string(&mut s)?;
        Ok(s)
    } else {
        Ok(String::from_utf8(raw)?)
    }
}
