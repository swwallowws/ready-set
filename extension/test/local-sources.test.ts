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
  localSourceDirs, loadLocalSources, localSourceKey, searchLocalSource, localNotesJson,
} from "../src/localSources.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tabridge = require(path.join(here, "..", "pkg", "tabridge.js"));
const midiFile = path.join(here, "..", "..", "web", "try", "catalog", "mutopia-177.mid");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ready-set-local-"));
try {
  // No folder yet: nothing loads, nothing breaks.
  const dirs = localSourceDirs(tmp, "");
  assert.deepEqual(dirs, [path.join(tmp, "sources")]);
  assert.equal(loadLocalSources(dirs, { require }).length, 0);

  // A fake module that serves one MIDI file, a module with the wrong shape, and
  // one that throws on load. Only the first is picked up.
  const src = path.join(tmp, "sources");
  fs.mkdirSync(src);
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
  const json = await localNotesJson(mods[0], recs[0].localId, (b) => tabridge.midi_build_notes_json(b, 0));
  const song = JSON.parse(json);
  const notes = song.tracks.reduce((n: number, t: any) => n + t.notes.length, 0);
  assert.ok(song.tracks.length > 0 && notes > 0, "the loaded song has notes");
  assert.ok(song.tempo > 0);

  // A module may also hand back notes-JSON directly.
  const direct = await localNotesJson(
    { id: "d", label: "D", search: async () => [], load: async () => ({ notesJson: json }) },
    "x", () => { throw new Error("should not convert"); },
  );
  assert.equal(direct, json);
  await assert.rejects(localNotesJson(
    { id: "e", label: "E", search: async () => [], load: async () => ({} as any) }, "x", () => ""));

  console.log(`local sources ok: 1 module, ${recs.length} rows, ${song.tracks.length} tracks, ${notes} notes`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
