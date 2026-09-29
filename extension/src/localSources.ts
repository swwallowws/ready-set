// Local source modules: an optional, user-installed way to add a search source
// to the extension without changing Ready Set itself.
//
// At startup the host looks in a fixed folder for CommonJS modules (*.js or
// *.cjs) and loads each one. A module exports:
//
//   module.exports = {
//     id: "my-source",                 // stable, unique id
//     label: "My source",              // shown on result rows and filters
//     async search(query) {            // -> [{ id, title, artist?, tracks? }]
//       ...
//     },
//     async load(id) {                 // -> { midi: Uint8Array } or { notesJson: string }
//       ...
//     },
//   };
//
// `load` returns either Standard MIDI File bytes, or Ready Set's notes-JSON
// (the shape midi_build_notes_json returns: { tempo, tracks: [{ name, isDrums,
// notes: [{ pitch, start, dur, velocity }] }], sections? }). Results show up in
// search next to the built-in sources and go through the same preview and
// Build path. No module, no change.
//
// This file has no SDK or WASM imports, so it runs under plain Node for tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LocalHit = { id: string | number; title: string; artist?: string; tracks?: number | null };
export type LocalLoad = { midi: Uint8Array } | { notesJson: string };
export interface LocalSourceModule {
  id: string;
  label: string;
  search(query: string): Promise<LocalHit[]>;
  load(id: string | number): Promise<LocalLoad>;
}
/** A search row from a local module, in the extension's SearchRec shape. */
export type LocalRec = {
  uid: string; id: number; artist: string; title: string; tracks: number | null;
  source: string; label: string; localId: string | number;
};

type Log = (...a: unknown[]) => void;
type Req = (id: string) => unknown;

/** Folders searched for local source modules, in order: the extension's
 *  storage directory (from the SDK Environment), then ~/.ready-set/sources
 *  (used when Live gives no storage directory, e.g. a CLI dev run). */
export function localSourceDirs(storageDirectory?: string | null, home = os.homedir()): string[] {
  const dirs: string[] = [];
  if (storageDirectory) dirs.push(path.join(storageDirectory, "sources"));
  if (home) dirs.push(path.join(home, ".ready-set", "sources"));
  return [...new Set(dirs)];
}

/** The row `source` key for a module: "local-<id>", safe for HTML ids. */
export const localSourceKey = (m: { id: string }) =>
  "local-" + String(m.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function isModule(x: any): x is LocalSourceModule {
  return !!x && typeof x.id === "string" && x.id.trim() !== "" && typeof x.label === "string"
    && typeof x.search === "function" && typeof x.load === "function";
}

/** Load every valid module found in `dirs`. A missing folder, a file that
 *  throws on load, or an export of the wrong shape is logged and skipped. The
 *  first module with a given id wins. */
export function loadLocalSources(dirs: string[], opts: { require?: Req; log?: Log } = {}): LocalSourceModule[] {
  const log = opts.log ?? (() => {});
  const req: Req | undefined = opts.require ?? (typeof require === "function" ? require : undefined);
  if (!req) { log("local sources: no require() available"); return []; }
  const out: LocalSourceModule[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => /\.c?js$/i.test(f)).sort(); }
    catch { continue; }   // no folder: nothing to load
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const mod: any = req(file);
        const m = isModule(mod) ? mod : isModule(mod?.default) ? mod.default : null;
        if (!m) { log("local sources: skipped (wrong shape)", file); continue; }
        const key = localSourceKey(m);
        if (seen.has(key)) { log("local sources: skipped (duplicate id)", file); continue; }
        seen.add(key);
        out.push(m);
        log("local sources: loaded", m.id, "from", file);
      } catch (e) {
        log("local sources: failed to load", file, String(e));
      }
    }
  }
  return out;
}

/** Search one module and map its hits to result rows (at most 25). */
export async function searchLocalSource(m: LocalSourceModule, query: string): Promise<LocalRec[]> {
  const hits = await m.search(query);
  const source = localSourceKey(m);
  return (Array.isArray(hits) ? hits : []).slice(0, 25)
    .filter((h) => h && h.id != null && h.title)
    .map((h, i) => ({
      uid: `${source}_${String(h.id).replace(/[^A-Za-z0-9_-]/g, "-")}`,
      id: typeof h.id === "number" ? h.id : i,
      artist: h.artist ? String(h.artist) : "",
      title: String(h.title),
      tracks: typeof h.tracks === "number" ? h.tracks : null,
      source, label: m.label, localId: h.id,
    }));
}

/** Load one item from a module as Ready Set notes-JSON. MIDI bytes go through
 *  `midiToNotesJson` (the WASM core's midi_build_notes_json). */
export async function localNotesJson(
  m: LocalSourceModule,
  id: string | number,
  midiToNotesJson: (bytes: Uint8Array) => string,
): Promise<string> {
  const r: any = await m.load(id);
  if (r && typeof r.notesJson === "string") {
    const song = JSON.parse(r.notesJson);
    if (!song || !Array.isArray(song.tracks)) throw new Error(`${m.label}: notesJson has no tracks`);
    return r.notesJson;
  }
  if (r && r.midi instanceof Uint8Array) return midiToNotesJson(new Uint8Array(r.midi));
  throw new Error(`${m.label}: load() must return { midi } or { notesJson }`);
}
