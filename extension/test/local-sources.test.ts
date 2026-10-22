// Local source module hook: a fake module that returns a MIDI file shows up in
// search and loads to notes-JSON through the WASM core, exactly as the
// extension host does it. Runs under plain Node (type stripping), no Live.
//
//   npm run test        (needs pkg/ from `npm run wasm`)

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  localSourceDirs, loadLocalSources, localSourceKey, searchLocalSource, localNotesJson, ensureSourceDir,
  type Parsers,
} from "../src/localSources.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tabridge = require(path.join(here, "..", "pkg", "tabridge.js"));
const midiFile = path.join(here, "..", "..", "web", "try", "catalog", "mutopia-177.mid");
const xmlFile = path.join(here, "..", "..", "tests", "data", "sample.musicxml");
// The host's parsers: the same WASM calls it makes for an opened file.
const parse: Parsers = {
  midi: (b) => tabridge.midi_build_notes_json(b, 0),
  gp: (b) => tabridge.guitarpro_build_notes_json(b, 0),
  musicxml: (t) => tabridge.musicxml_build_notes_json(t, 0),
};
const noteCount = (json: string) => JSON.parse(json).tracks.reduce((n: number, t: any) => n + t.notes.length, 0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ready-set-local-"));
try {
  // Only the storage directory's folder (Live 12.4.15 allows no other); the
  // home folder is the fallback for dev runs with no storage directory.
  assert.deepEqual(localSourceDirs(tmp, "/home/x"), [path.join(tmp, "sources")]);
  assert.deepEqual(localSourceDirs(undefined, "/home/x"), [path.join("/home/x", ".ready-set", "sources")]);
  assert.deepEqual(localSourceDirs(undefined, ""), []);

  // No folder yet: nothing loads, nothing breaks; the host then makes it.
  const dirs = localSourceDirs(tmp, "");
  assert.equal(loadLocalSources(dirs, { require }).length, 0);
  const src = path.join(tmp, "sources");
  ensureSourceDir(src);
  assert.ok(fs.statSync(src).isDirectory(), "the sources folder is made");
  ensureSourceDir(src); // already there: fine

  // A fake module that serves one MIDI file, a module with the wrong shape, and
  // one that throws on load. Only the first is picked up.
  fs.writeFileSync(path.join(src, "a-fake.js"), `
    const fs = require("node:fs");
    module.exports = {
      id: "Fake Source",
      label: "Fake",
      async search(q) {
        return q.includes("rondo")
          ? [{ id: "r-1", title: "Rondo in E-flat", artist: "C. P. E. Bach" }, { id: 7, title: "Other", tracks: 2 }]
          : [];
      },
      async load(id) {
        if (id !== "r-1") throw new Error("unknown id " + id);
        return { midi: fs.readFileSync(${JSON.stringify(midiFile)}) };
      },
    };`);
  fs.writeFileSync(path.join(src, "b-wrong-shape.js"), `module.exports = { id: "x" };`);
  fs.writeFileSync(path.join(src, "c-throws.js"), `throw new Error("boom");`);
  fs.writeFileSync(path.join(src, "notes.txt"), `not a module`);

  const logs: string[] = [];
  const mods = loadLocalSources(dirs, { require, log: (...a) => logs.push(a.join(" ")) });
  assert.equal(mods.length, 1, "only the valid module loads");
  assert.equal(mods[0].label, "Fake");
  assert.equal(localSourceKey(mods[0]), "local-fake-source");
  assert.ok(logs.some((l) => l.includes("wrong shape")), "wrong-shape module is logged");
  assert.ok(logs.some((l) => l.includes("failed to load")), "throwing module is logged");

  // Search: rows in the extension's SearchRec shape, labelled by the module.
  const recs = await searchLocalSource(mods[0], "bach rondo");
  assert.equal(recs.length, 2);
  assert.deepEqual(
    { uid: recs[0].uid, source: recs[0].source, label: recs[0].label, title: recs[0].title, artist: recs[0].artist, tracks: recs[0].tracks, localId: recs[0].localId },
    { uid: "local-fake-source_r-1", source: "local-fake-source", label: "Fake", title: "Rondo in E-flat", artist: "C. P. E. Bach", tracks: null, localId: "r-1" },
  );
  assert.equal(recs[1].tracks, 2);
  assert.equal((await searchLocalSource(mods[0], "nothing")).length, 0);

  // Load: MIDI bytes -> notes-JSON via the same WASM call the host uses.
  const json = await localNotesJson(mods[0], recs[0].localId, parse);
  const song = JSON.parse(json);
  const notes = noteCount(json);
  assert.ok(song.tracks.length > 0 && notes > 0, "the loaded song has notes");
  assert.ok(song.tempo > 0);

  const mod = (load: () => Promise<any>) => ({ id: "m", label: "M", search: async () => [], load });
  const refuse = () => { throw new Error("wrong parser"); };

  // MusicXML text goes through the same parser as an opened file.
  const xml = await localNotesJson(mod(async () => ({ musicxml: fs.readFileSync(xmlFile, "utf8") })), "x", parse);
  assert.ok(noteCount(xml) > 0, "MusicXML from a module has notes");

  // Guitar Pro bytes reach the Guitar Pro parser (its reading is tested in tests/guitarpro.rs).
  const gpBytes = new Uint8Array([1, 2, 3]);
  let gpGot: Uint8Array | null = null;
  const gp = await localNotesJson(mod(async () => ({ gp: gpBytes })), "x",
    { midi: refuse, musicxml: refuse, gp: (b) => { gpGot = b; return json; } });
  assert.equal(gp, json);
  assert.deepEqual(gpGot, gpBytes);
  // ...and the real parser refuses bytes that aren't Guitar Pro, as for an opened file.
  await assert.rejects(localNotesJson(mod(async () => ({ gp: gpBytes })), "x", parse));

  // A module may also hand back notes-JSON directly.
  const direct = await localNotesJson(mod(async () => ({ notesJson: json })), "x",
    { midi: refuse, gp: refuse, musicxml: refuse });
  assert.equal(direct, json);
  await assert.rejects(localNotesJson(mod(async () => ({})), "x", parse), /must return/);

  console.log(`local sources ok: 1 module, ${recs.length} rows, ${song.tracks.length} tracks, ${notes} notes`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
