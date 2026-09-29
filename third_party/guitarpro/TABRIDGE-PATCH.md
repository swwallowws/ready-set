# guitarpro 0.4.3, patched for tabridge

Upstream: https://codeberg.org/slundi/scorelib (crates.io `guitarpro` 0.4.3,
MIT, by slundi). Copied here from the published crate with these changes:

- `Cargo.toml`: `zip` uses `default-features = false` and only the
  `deflate-flate2-zlib-rs` feature. zip's default features pull in zstd (a C
  library), which doesn't build for `wasm32-unknown-unknown`. Guitar Pro 7
  (`.gp`) files are plain deflate zips, so nothing tabridge reads needs the
  other codecs.

- `src/io/gpif.rs`, `src/io/gpif_import.rs` (GP6/GP7 import fixes, found by
  running real Guitar Pro 7 files from alphaTab's test data):
  - tracks start with no strings, so the GP7 staves tuning is used (the
    default six standard strings made that branch dead, so every GP7 file
    lost its tuning);
  - GP7 `<MidiConnection>` channel and `<Sounds>` program are read when
    there's no `<GeneralMidi>`;
  - an instrument set of type `drumKit` marks the track as percussion;
  - percussion notes take their GM note from the `Midi` property.

Packaging leftovers (`.cargo-checksum.json`, `.cargo_vcs_info.json`,
`Cargo.lock`, the audit report, format notes and the MuseScore samples) are
left out. Drop this copy for the crates.io release once upstream makes zip's
extra codecs optional.
