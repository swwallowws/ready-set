// Run the extension host's Guitar Pro path in plain Node: load the Node-target
// WASM package and parse a .gp the way extension.ts does on a "file" action.
//
// Run: node scripts/extension_gp_check.cjs [file.gp]

const fs = require("node:fs");
const path = require("node:path");
const tabridge = require("../extension/pkg/tabridge.js");

const file = process.argv[2] || path.join(__dirname, "..", "spike", "shots", "sample.gp");
const bytes = new Uint8Array(fs.readFileSync(file));
console.log("is_guitarpro:", tabridge.is_guitarpro(bytes));
const song = JSON.parse(tabridge.guitarpro_build_notes_json(bytes, 0));
console.log("tempo:", song.tempo, "tracks:", song.tracks.map((t) => `${t.name} (${t.notes.length} notes)`).join(", "));
console.log("pitches:", song.tracks[0].notes.map((n) => n.pitch).join(" "));
