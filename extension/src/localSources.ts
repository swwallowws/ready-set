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
//     async load(id) {                 // -> one of { gp }, { musicxml }, { midi }, { notesJson }
//       ...
//     },
//   };
//
// `load` returns a Guitar Pro file's bytes ({ gp }), MusicXML text
// ({ musicxml }), Standard MIDI File bytes ({ midi }), or Ready Set's
// notes-JSON ({ notesJson }: the shape midi_build_notes_json returns:
// { tempo, tracks: [{ name, isDrums, notes: [{ pitch, start, dur, velocity }] }],
// sections? }). Guitar Pro and MusicXML go through the same parser as an
// opened file. Results show up in search next to the built-in sources and go
// through the same preview and Build path. No module, no change.
//
// This file has no SDK or WASM imports, so it runs under plain Node for tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LocalHit = { id: string | number; title: string; artist?: string; tracks?: number | null };
export type LocalLoad =
  | { gp: Uint8Array } | { musicxml: string } | { midi: Uint8Array } | { notesJson: string };
/** The WASM core's parsers, each to notes-JSON (passed in so tests run without it). */
export type Parsers = {
  midi: (bytes: Uint8Array) => string;
  gp: (bytes: Uint8Array) => string;
  musicxml: (text: string) => string;
};
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

/** The folder searched for local source modules: "sources" in the extension's
 *  storage directory (from the SDK Environment). Since Ableton Live 12.4.15
 *  an extension can't read outside it, so ~/.ready-set/sources is only used
 *  when Live gives no storage directory (a CLI dev run). */
export function localSourceDirs(storageDirectory?: string | null, home = os.homedir()): string[] {
  if (storageDirectory) return [path.join(storageDirectory, "sources")];
  return home ? [path.join(home, ".ready-set", "sources")] : [];
}

/** Make the sources folder if it's missing, so there's a place to drop a
 *  module into. A folder that can't be made is left alone. */
export function ensureSourceDir(dir: string | undefined, log: Log = () => {}): void {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { log("local sources: couldn't make", dir, String(e)); }
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

/** Load one item from a module as Ready Set notes-JSON. Guitar Pro bytes,
 *  MusicXML text and MIDI bytes go through the WASM core's parsers. */
export async function localNotesJson(
  m: LocalSourceModule,
  id: string | number,
  parse: Parsers,
): Promise<string> {
  const r: any = await m.load(id);
  if (r && typeof r.notesJson === "string") {
    const song = JSON.parse(r.notesJson);
    if (!song || !Array.isArray(song.tracks)) throw new Error(`${m.label}: notesJson has no tracks`);
    return r.notesJson;
  }
  if (r && r.gp instanceof Uint8Array) return parse.gp(new Uint8Array(r.gp));
  if (r && typeof r.musicxml === "string") return parse.musicxml(r.musicxml);
  if (r && r.midi instanceof Uint8Array) return parse.midi(new Uint8Array(r.midi));
  throw new Error(`${m.label}: load() must return { gp }, { musicxml }, { midi } or { notesJson }`);
}
