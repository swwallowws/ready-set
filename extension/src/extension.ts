import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import * as tabridge from "../pkg/tabridge.js";
import interfaceHtml from "./interface.html";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// Source glue shared with the website (web/app.js): search URLs, result
// normalization, merge, labels. The parse/build core is shared via WASM.
import {
  bitmidiSearchUrl,
  normBitmidi, normFreemidi, normMutopia,
  firstFreemidiArtist, mergeInterleaved, recLabel,
  freemidiSearchUrl, freemidiArtistPageUrl, mutopiaSearchUrl,
} from "../../shared/sources.js";
import { startWindowServer } from "./windowServer.js";
import { isFreshSet } from "./freshSet.js";
import { instrumentFor, voiceFamily } from "./instruments.js";

// ---- drum-kit synthesis (host side) -------------------------------------
// The preview synths drums with Web Audio; here we render the SAME voices to
// small WAV files so the built Set is audible too (the SDK can't load a factory
// kit, but Simpler.replaceSample can load a file). Own synthesis = no licensing.
const SR = 44100;
type Voice = "kick" | "snare" | "clap" | "hatC" | "hatO" | "crash" | "ride" | "tomL" | "tomM" | "tomH";
function drumVoice(note: number): Voice {
  if (note === 35 || note === 36) return "kick";
  if (note === 38 || note === 40 || note === 37) return "snare";
  if (note === 39) return "clap";
  if (note === 42 || note === 44) return "hatC";
  if (note === 46) return "hatO";
  if (note === 49 || note === 52 || note === 55 || note === 57) return "crash";
  if (note === 51 || note === 53 || note === 59) return "ride";
  if (note <= 43) return "tomL";
  if (note <= 47) return "tomM";
  return "tomH";
}
function synthVoice(v: Voice): Float32Array {
  const durs: Record<Voice, number> = { kick: 0.28, snare: 0.2, clap: 0.22, hatC: 0.06, hatO: 0.32, crash: 0.5, ride: 0.4, tomL: 0.3, tomM: 0.28, tomH: 0.24 };
  const n = Math.floor(SR * durs[v]), out = new Float32Array(n);
  const rnd = () => Math.random() * 2 - 1;
  let hp = 0, prev = 0, ph = 0;
  const tomF = v === "tomL" ? 90 : v === "tomM" ? 140 : 200;
  for (let i = 0; i < n; i++) {
    const t = i / SR; let s = 0;
    if (v === "kick") { const f = 45 + 85 * Math.exp(-t / 0.03); ph += (2 * Math.PI * f) / SR; s = Math.sin(ph) * Math.exp(-t / 0.09); }
    else if (v === "tomL" || v === "tomM" || v === "tomH") { const f = tomF * (1 + 0.4 * Math.exp(-t / 0.05)); ph += (2 * Math.PI * f) / SR; s = Math.sin(ph) * Math.exp(-t / 0.1); }
    else { // noise-based: snare/clap/hats/cymbals
      const x = rnd(); const y = 0.9 * (hp + x - prev); hp = y; prev = x;   // one-pole highpass
      const dec = v === "hatC" ? 0.012 : v === "hatO" ? 0.09 : v === "snare" || v === "clap" ? 0.05 : v === "ride" ? 0.16 : 0.22;
      s = y * Math.exp(-t / dec);
      if (v === "snare") s += Math.sin(2 * Math.PI * 180 * t) * 0.3 * Math.exp(-t / 0.03);
    }
    out[i] = Math.max(-1, Math.min(1, s * 0.9));
  }
  return out;
}
function floatToWav(samples: Float32Array): Buffer {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE((samples[i] * 32767) | 0, 44 + i * 2);
  return buf;
}

// No global menu exists, so attach the action to the objects you can right-click
// almost anywhere.
const SCOPES = ["AudioTrack", "MidiTrack", "ClipSlot", "Scene"] as const;
// On a dev run, fetches go through the local serve.py proxy first (the SAME
// fetch path the website uses); set TABRIDGE_PROXY to point elsewhere. An
// installed extension fetches directly (see useProxy and fetchText).
const PROXY_BASE = process.env.TABRIDGE_PROXY || "http://localhost:8000";
// Some archives reject requests without a browser-like UA. serve.py adds it
// itself; HDRS is for direct fetches (the host runs in Node, so there is no
// CORS to fight on that path).
const HDRS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
};

// "midi" | "freemidi" | "mutopia" | "file".
type Source = string;
// A merged result set holds rows from every source, so uid ("<source>_<id>")
// is the collision-proof identity used everywhere (ids can collide across
// sources). MIDI-bearing rows carry either downloadUrl (BitMidi/Mutopia, direct)
// or freemidiId (FreeMIDI, fetched via the proxy's two-step endpoint). tracks is
// unknown (null) for those until the file is fetched.
type SearchRec = {
  uid: string; id: number; artist: string; title: string; tracks: number | null; source: Source;
  downloadUrl?: string; freemidiId?: string; label?: string; intro?: any;
  tempo?: number;   // BPM, to one decimal, once the song's file has loaded
};
type NoteJson = { pitch: number; start: number; dur: number; velocity: number };
type TrackJson = { name: string; isDrums: boolean; notes: NoteJson[] };
type SectionJson = { name: string; start: number; length: number };
type SongJson = { tempo: number; tracks: TrackJson[]; sections?: SectionJson[] };

// An error as the window shows it. fetch's "fetch failed" keeps the real
// reason (refused, DNS, TLS…) in `cause`, so add it.
function why(e: unknown): string {
  const c: any = (e as any)?.cause;
  return String(e) + (c ? ` (${[c.code, c.message].filter(Boolean).join(": ") || String(c)})` : "");
}

// Resolve to `fallback` if `p` doesn't settle within `ms`, so one slow or hung
// source can't hold up the whole search. The abandoned promise keeps running
// harmlessly (Node) and its result is ignored.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const dbg = (...a: unknown[]) => {
    try { console.log("[tabridge]", ...a); } catch { /* ignore */ }
  };

  // An installed extension has a storage directory; a dev run (npm start) has none.
  const storageDirectory = (() => {
    try { return (context as any).environment?.storageDirectory as string | undefined; } catch { return undefined; }
  })();

  // ---- fetching (direct; the serve.py proxy on a dev run) ------------------
  // One fetch path for the online archives. On a dev run (no storage
  // directory, or TABRIDGE_PROXY set) it goes through serve.py first, the same
  // fetcher the website uses, and falls back to fetching directly. An
  // installed extension never has serve.py, so it fetches directly from the
  // start (the host runs in Node: no CORS to work around).
  const useProxy = !!process.env.TABRIDGE_PROXY || !storageDirectory;
  dbg(useProxy ? `fetching through ${PROXY_BASE} first (dev run)` : "fetching directly");
  async function fetchText(url: string): Promise<string> {
    if (useProxy) try {
      const r = await fetch(`${PROXY_BASE}/proxy?url=${encodeURIComponent(url)}`);
      if (r.ok) return await r.text();
      dbg("proxy non-ok", r.status, url);
    } catch (e) { dbg("proxy unreachable, fetching direct", String(e)); }
    return (await fetch(url, { headers: HDRS })).text();
  }

  // Fetch + normalize via the shared source layer (also used by the website).
  const searchBitmidi = async (q: string): Promise<SearchRec[]> => normBitmidi(await fetchText(bitmidiSearchUrl(q)));
  const searchMutopia = async (q: string): Promise<SearchRec[]> => normMutopia(await fetchText(mutopiaSearchUrl(q))) as SearchRec[];
  // FreeMIDI's search page is thin on song matches; if so, follow the top artist
  // page to enumerate that artist's songs (same logic as the website).
  const searchFreemidi = async (q: string): Promise<SearchRec[]> => {
    const html = await fetchText(freemidiSearchUrl(q));
    let recs: SearchRec[] = normFreemidi(html) as SearchRec[];
    if (recs.length < 5) {
      const artist = firstFreemidiArtist(html);
      if (artist) {
        try {
          const ahtml = await fetchText(freemidiArtistPageUrl(artist.path));
          const byId = new Map(recs.map((r) => [r.uid, r]));
          for (const r of normFreemidi(ahtml, artist.name) as SearchRec[]) byId.set(r.uid, r);
          recs = [...byId.values()];
        } catch { /* keep the title matches */ }
      }
    }
    return recs.slice(0, 25);
  };
  // FreeMIDI gates its downloads: a bare fetch of getter-<id> 500s. Visit
  // download3-<id> first for a session cookie, then fetch getter-<id> with it
  // and that page as referer (what serve.py does with curl). The proxy is
  // tried first on a dev run; an installed extension (or a dev run without
  // serve.py) does the handshake itself, since Node has no CORS to get in the way.
  async function fetchFreemidiBytes(id: string): Promise<Uint8Array> {
    if (useProxy) try {
      const r = await fetch(`${PROXY_BASE}/freemidi?id=${encodeURIComponent(id)}`);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
      dbg("proxy non-ok (freemidi)", r.status, id);
    } catch (e) { dbg("proxy unreachable (freemidi), direct", String(e)); }
    if (!/^\d+$/.test(id)) throw new Error(`bad FreeMIDI id ${id}`);
    const step1 = `https://freemidi.org/download3-${id}`;
    const r1 = await fetch(step1, { headers: HDRS });
    await r1.arrayBuffer();
    const cookie = r1.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const r2 = await fetch(`https://freemidi.org/getter-${id}`, { headers: { ...HDRS, Cookie: cookie, Referer: step1 } });
    if (!r2.ok) throw new Error(`FreeMIDI answered ${r2.status}`);
    const bytes = new Uint8Array(await r2.arrayBuffer());
    if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "MThd") throw new Error("FreeMIDI didn't send a MIDI file");
    return bytes;
  }
  // Binary fetch (for .mid files): direct, or proxy-first on a dev run.
  async function fetchBytes(url: string): Promise<Uint8Array> {
    if (useProxy) try {
      const r = await fetch(`${PROXY_BASE}/proxy?url=${encodeURIComponent(url)}`);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
      dbg("proxy non-ok (bytes)", r.status, url);
    } catch (e) { dbg("proxy unreachable (bytes), direct", String(e)); }
    return new Uint8Array(await (await fetch(url, { headers: HDRS })).arrayBuffer());
  }

  // ---- write the tabs into the current Set (Model A transpose) ------------
  // Resolve a record to the flat notes-JSON (at concert pitch; transpose is
  // applied later, via a Pitch device in the Set, or live in the preview). One
  // fetch+build per record, cached across prefetch / Preview / Build. Branches
  // on the source: every archive yields a .mid that the WASM core reads into
  // the SAME notes-JSON shape.
  const notesCache = new Map<string, string>();
  async function ensureNotesJson(rec: SearchRec): Promise<string> {
    const hit = notesCache.get(rec.uid);
    if (hit) return hit;
    let json: string;
    if (rec.source === "file") {
      // Opened files are parsed up front (the "file" action), so they're always
      // cached; a miss means the cache was cleared.
      throw new Error("the opened file is no longer loaded; open it again");
    } else {
      // FreeMIDI needs the proxy's two-step endpoint; BitMidi/Mutopia have a
      // direct URL.
      const bytes = rec.source === "freemidi"
        ? await fetchFreemidiBytes(rec.freemidiId!)
        : await fetchBytes(rec.downloadUrl!);
      json = tabridge.midi_build_notes_json(bytes, 0);
    }
    if (notesCache.size > 40) notesCache.clear();
    notesCache.set(rec.uid, json);
    // A loaded row learns its tempo and track count, for its line in the results.
    try {
      const song: SongJson = JSON.parse(json);
      rec.tempo = Math.round(song.tempo * 10) / 10;
      if (rec.tracks == null) rec.tracks = song.tracks.length;
    } catch { /* the row keeps what it had */ }
    return json;
  }

  // Note data for the in-modal audio/roll preview, in COLUMNAR form (p/s/d/k/v
  // arrays) so the modal's data: URL stays small: the whole song is ~116 KB
  // encoded vs ~344 KB as objects. k=1 marks a drum note (the modal synths those
  // as percussion); v is velocity 0..1, which sets the note's accent tint; f is
  // the family of the instrument its track gets in the set (0 Wavetable,
  // 1 Tension, 2 Operator, 3 Electric; instruments.ts), so the preview voices it alike. windowBeats limits to the first N beats (intro quick-play);
  // null renders the whole song. Notes are original pitch; transpose is live.
  const INTRO_BEATS = 32, PREVIEW_MAX_NOTES = 12000, PREFETCH_INTROS = 8;
  // A source that doesn't answer within this budget is dropped from the current
  // search rather than stalling the results view (FreeMIDI's multi-hop scrape is
  // the usual laggard). Its rows just won't appear until the next search.
  const SEARCH_TIMEOUT_MS = 6000, PREFETCH_TIMEOUT_MS = 4000;
  // How much longer a live window waits for a source that missed the search
  // (BitMidi has taken 32 s), in the background, before giving up on it.
  const LATE_TIMEOUT_MS = 40000;
  // Only BitMidi gets its previews prefetched during search; the archive
  // downloads (FreeMIDI two-step, Mutopia) are too slow to block on, so those
  // rows fall back to an on-click load.
  const prefetches = (source: string) => source === "midi";
  function buildPreview(notesJson: string, label: string, windowBeats: number | null) {
    const song: SongJson = JSON.parse(notesJson);
    let rows: [number, number, number, number, number, number][] = [];
    let maxEnd = 0;
    for (const t of song.tracks) {
      const k = t.isDrums ? 1 : 0;
      const f = voiceFamily(t.name, t.isDrums);
      for (const n of t.notes) {
        if (windowBeats != null && n.start >= windowBeats) continue;
        const dur = windowBeats != null ? Math.min(n.dur, windowBeats - n.start) : n.dur;
        rows.push([n.pitch, +n.start.toFixed(3), +dur.toFixed(3), k, +((n.velocity ?? 100) / 127).toFixed(2), f]);
        if (n.start + n.dur > maxEnd) maxEnd = n.start + n.dur;
      }
    }
    rows.sort((a, b) => a[1] - b[1]);
    const truncated = rows.length > PREVIEW_MAX_NOTES;
    if (truncated) rows = rows.slice(0, PREVIEW_MAX_NOTES);
    const beats = windowBeats != null ? windowBeats : Math.max(1, Math.ceil(maxEnd));
    return {
      label, tempo: song.tempo, beats, truncated,   // exact: the preview plays at it
      p: rows.map((r) => r[0]), s: rows.map((r) => r[1]), d: rows.map((r) => r[2]), k: rows.map((r) => r[3]),
      v: rows.map((r) => r[4]), f: rows.map((r) => r[5]),
    };
  }

  // Render each drum voice to a WAV once per session and cache the file paths.
  // Same voices as the preview's Web-Audio drumHit, so what you hear in the
  // modal is what lands in the Set.
  let drumSamples: Partial<Record<Voice, string>> | null = null;
  function ensureDrumSamples(): Partial<Record<Voice, string>> {
    if (drumSamples) return drumSamples;
    const base = (() => {
      try { return (context as any).environment?.tempDirectory as string; } catch { return null; }
    })() || os.tmpdir();
    const dir = path.join(base, "tabridge-drums");
    fs.mkdirSync(dir, { recursive: true });
    const voices: Voice[] = ["kick", "snare", "clap", "hatC", "hatO", "crash", "ride", "tomL", "tomM", "tomH"];
    const out: Partial<Record<Voice, string>> = {};
    for (const v of voices) {
      const fp = path.join(dir, `${v}.wav`);
      try { fs.writeFileSync(fp, floatToWav(synthVoice(v))); out[v] = fp; }
      catch (e) { dbg("drum wav", v, String(e)); }
    }
    drumSamples = out;
    return out;
  }

  // Build an audible drum kit: a Drum Rack whose pads (one per distinct note in
  // the part) each hold a Simpler loaded with our synthesized sample. If any
  // step fails we still leave the (possibly empty) rack so the track exists.
  async function buildDrumKit(mt: any, notes: NoteJson[]) {
    let rack: any;
    try { rack = await mt.insertDevice("Drum Rack", 0); dbg("drum rack inserted"); }
    catch (e) { dbg("drum rack fail", String(e)); return; }
    let samples: Partial<Record<Voice, string>>;
    try { samples = ensureDrumSamples(); } catch (e) { dbg("drum samples fail", String(e)); return; }
    const used = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
    let pad = 0;
    for (const note of used) {
      const wav = samples[drumVoice(note)];
      if (!wav) continue;
      try {
        const chain = await rack.insertChain(pad++);
        try { chain.receivingNote = note; } catch { /* some builds set this differently */ }
        const simpler = await chain.insertDevice("Simpler", 0);
        await simpler.replaceSample(wav);
        // No transpose needed: a Drum Rack translates every pad's receiving note
        // to C3 before the chain, and C3 is Simpler's root, so the sample plays
        // back at its recorded pitch. That's exactly the unpitched behavior we
        // want; a compensating transpose here would WRONGLY re-pitch each hit.
      } catch (e) { dbg("drum pad", note, String(e)); }
    }
    dbg("drum kit pads", pad);
  }

  async function build(
    notesJson: string,
    semitones: number,
    label: string,
    update?: (t: string, p?: number) => Promise<void>,
  ) {
    // Notes at ORIGINAL pitch; the transpose lives on a per-track Pitch device
    // (the Live note API can't carry pitch-bend, so articulations flatten here;
    // that's why the website keeps the full-fidelity .als path).
    const song: SongJson = JSON.parse(notesJson);

    // The SDK can't create a group track or move tracks into one (groupTrack is
    // read-only), so instead every track gets a shared prefix. They land as one
    // contiguous, labeled block you can select and ⌘G into a group in one motion.
    const prefix = label.replace(/\s+/g, " ").trim().slice(0, 22) || "Ready Set";

    const tracks = song.tracks.filter((t) => t.notes.length);

    // Session view mirrors the .als: one Scene per song section (row s = section
    // s, filling from the top), and a per-section clip on each track (0-based
    // within the section) so launching a scene plays that verse/chorus across
    // every track. Sections start at row 0: existing scene rows are reused, and
    // NEW rows are created only when the song has more sections than the Set has
    // scenes. The Arrangement still gets the full linear clip per track (below).
    const song2 = context.application.song;
    const songEnd = Math.max(1, ...tracks.map((t) => t.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0)));
    const sections: SectionJson[] = (song.sections && song.sections.length
      ? song.sections
      : [{ name: prefix, start: 0, length: songEnd }]).slice(0, 48);

    // Group the whole build into ONE undo step. Every mutation is undoable on
    // its own, so without this a single ⌘Z would peel back just the last device
    // and the user would have to undo dozens of times to clear an import.
    // withinTransaction needs a SYNCHRONOUS callback, but returning the async
    // chain keeps the transaction open until every mutation settles, so one
    // ⌘Z removes all the tracks, clips, scenes, and devices together.
    await context.withinTransaction(() => (async () => {
    // A fresh set (no track holds a clip yet) takes the song's tempo; a set
    // with material keeps its own, and the song plays in time at it (notes sit
    // on bars and beats). Checked before this build adds anything. A MIDI file
    // stores tempo as microseconds per beat (140.00014000014), so round it.
    if (isFreshSet(song2.tracks)) {
      const tempo = Math.round(song.tempo * 100) / 100;
      try { song2.tempo = tempo; dbg("fresh set: tempo set to", tempo); }
      catch (e) { dbg("tempo", String(e)); }
    } else dbg("set has material: tempo kept at", song2.tempo);

    for (let s = 0; s < sections.length; s++) {
      // Grow the scene list until row s exists (createScene(length) appends).
      while (song2.scenes.length <= s) {
        try { await song2.createScene(song2.scenes.length); }
        catch (e) { dbg("scene create", s, String(e)); break; }
      }
      const sc = song2.scenes[s];
      if (sc) { try { sc.name = sections[s].name || `Section ${s + 1}`; } catch { /* ignore */ } }
    }
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      await update?.(`Adding ${tr.name || "track"}…`, Math.round((i / tracks.length) * 100));

      const mt = await context.application.song.createMidiTrack();
      const part = tr.name || (tr.isDrums ? "Drums" : "Track");
      try { mt.name = `${prefix} · ${part}`; } catch { /* ignore */ }

      // Arrangement: the whole part as ONE clip at bar 1. Note start times are
      // absolute song beats (e.g. the guitars enter at beat 32), so every track's
      // clip starts at arrangement position 0 and they stay in sync.
      const end = tr.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
      const clip = await mt.createMidiClip(0, Math.max(1, Math.ceil(end)));
      clip.notes = tr.notes.map((n) => ({
        pitch: n.pitch, startTime: n.start, duration: n.dur, velocity: n.velocity,
      }));

      // Session: one clip per section, notes 0-based within the section. Each
      // clip is scoped to its section (not the whole song at absolute beats), so
      // it loops cleanly; that's what made the old whole-song Session clips
      // drift. Sections with no notes for this track stay as empty slots.
      for (let s = 0; s < sections.length; s++) {
        const sec = sections[s], secEnd = sec.start + sec.length;
        const inSec = tr.notes.filter((n) => n.start >= sec.start - 1e-6 && n.start < secEnd - 1e-6);
        if (!inSec.length) continue;
        try {
          const slot = mt.clipSlots[s]; // row s = section s (0-based)
          if (!slot) continue;
          const sclip = await slot.createMidiClip(Math.max(1, sec.length));
          sclip.notes = inSec.map((n) => ({
            pitch: n.pitch, startTime: n.start - sec.start, duration: n.dur, velocity: n.velocity,
          }));
        } catch (e) { dbg("session clip", s, String(e)); }
      }

      // Transpose = a Pitch MIDI-effect at the head of the chain (melodic only,
      // so it sits before the instrument and drums stay at concert pitch).
      if (!tr.isDrums) {
        try {
          const dev = await mt.insertDevice("Pitch", 0);
          const p = dev.parameters.find((pp) => /pitch|transpose/i.test(pp.name));
          if (p) await p.setValue(Math.max(p.min, Math.min(p.max, semitones)));
        } catch (e) { dbg("pitch device", String(e)); }
      }

      // A stock instrument so the track makes sound out of the box. The SDK
      // only loads a device's DEFAULT preset (no preset files / browser), so
      // this is NOT the website template's tuned MPE preset; those ride the
      // .als.
      if (tr.isDrums) {
        // Build a playable kit from our own synthesized samples (the default
        // Drum Rack is empty, so the drums were silent before).
        await buildDrumKit(mt, tr.notes);
      } else {
        // Melodic instrument goes after the Pitch effect (index 1).
        for (const cand of instrumentFor(tr.name, false)) {
          try { await mt.insertDevice(cand, 1); dbg("instrument", tr.name, cand); break; }
          catch (e) { dbg("instrument fail", cand, String(e)); }
        }
      }
    }
    await update?.("Done", 100);
    })());
  }

  // ---- command: the import window -----------------------------------------
  // start (open a file, or search) -> preview -> build, or
  // start -> results -> preview -> build. The user's own file is the main path;
  // online search is secondary, and its user-upload sources (BitMidi, FreeMIDI)
  // are opt-in and personal-use only. Mutopia is always searched.
  //
  // The window is served from a local server (windowServer.ts), so search,
  // load and preview run while it stays open; only Build closes it. If the
  // server can't start, the window falls back to closing and reopening for
  // each step (a data: URL modal), with the host's progress dialogs between.
  context.commands.registerCommand("tabridge.import", async () => {
    let mode: "start" | "results" | "preview" = "start";
    let results: SearchRec[] = [];
    let query = "";
    let uploads = false;
    let semitones = 0;
    let selectedUid: string | null = null;
    let error = "";
    let preview: any = null;   // whole-song preview (columnar) for "preview" mode
    let previewFrom: "start" | "results" = "start";
    let intro: any = null;     // 32-beat intro (columnar) shown inline in "results"
    let fileRec: SearchRec | null = null, fileJson = "";   // the opened file, parsed
    const findRec = (uid: string) =>
      fileRec && uid === fileRec.uid ? fileRec : results.find((r) => r.uid === uid);
    const notesFor = (rec: SearchRec) => (rec.source === "file" ? Promise.resolve(fileJson) : ensureNotesJson(rec));

    let live = false;   // the window is served by the local server
    // Sources that didn't answer within SEARCH_TIMEOUT_MS keep going in a live
    // window: `pending` names them (the window says "Still searching…"), and
    // a background "more" step waits for them and adds their rows at the end.
    // searchSeq tells a late answer which search it belongs to.
    let searchSeq = 0, pending: string[] = [];
    let late: { name: string; rows: Promise<SearchRec[]> }[] = [];
    const state = () => ({
      mode, results, query, uploads, semitones, error, selectedUid, previewFrom, live,
      searchSeq, pending,
      intro: mode === "results" ? intro : null,
      preview: mode === "preview" ? preview : null,
    });
    // Load the first bars of the top FAST-source rows so each of their play
    // buttons sounds INLINE on one click, with no round trip. Slow archive rows
    // are skipped and load on click. Each is time-boxed so one slow file can't
    // stall the view.
    async function prefetchIntros(rows: SearchRec[], upd?: (t: string, p?: number) => Promise<void>) {
      const top = rows.filter((r) => prefetches(r.source)).slice(0, PREFETCH_INTROS);
      let done = 0;
      await Promise.allSettled(top.map(async (rec) => {
        try {
          const json = await withTimeout(ensureNotesJson(rec), PREFETCH_TIMEOUT_MS, "");
          if (!json) throw new Error("prefetch timed out");
          // (ensureNotesJson gave the row its track count and tempo.)
          rec.intro = { ...buildPreview(json, recLabel(rec), INTRO_BEATS), uid: rec.uid };
        } catch { /* row falls back to on-click load */ }
        await upd?.("Loading previews…", 20 + Math.round((++done / Math.max(1, top.length)) * 75));
      }));
    }
    const page = () => interfaceHtml.replace("'__STATE__'", () => JSON.stringify(state()));
    // A live window shows its own "Searching…"; the reopening one gets the
    // host's progress dialog between windows.
    const withProgress = (text: string, fn: (upd: (t: string, p?: number) => Promise<void>) => Promise<void>) =>
      live ? fn(async () => {}) : context.ui.withinProgressDialog(text, { progress: 0 }, fn);

    // One step of the window, everything but Build and Cancel.
    async function act(payload: any): Promise<void> {
      if (payload.action !== "more") error = "";   // the background step leaves messages alone

      // The user's own file: parse it with the same WASM core as the website,
      // then go straight to the whole-song preview.
      if (payload.action === "file") {
        semitones = payload.semitones | 0;
        const name = String(payload.name || "file");
        try {
          const bytes = new Uint8Array(Buffer.from(String(payload.data || ""), "base64"));
          const isMidi = bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "MThd";
          // A MIDI file already opens in Live: drag it into the set. This is for what Live can't open.
          if (isMidi) throw new Error("MIDI files open in Live directly: drag one into your set. Ready Set takes Guitar Pro and MusicXML files");
          fileJson = tabridge.is_guitarpro(bytes)
            ? tabridge.guitarpro_build_notes_json(bytes, 0)
            : tabridge.musicxml_build_notes_json(Buffer.from(bytes).toString("utf8"), 0);
          const song: SongJson = JSON.parse(fileJson);
          const title = name.replace(/\.(musicxml|xml|midi?|gpx?|gp[345])$/i, "");
          fileRec = { uid: "file_0", id: 0, artist: "", title, tracks: song.tracks.length, source: "file" };
          selectedUid = fileRec.uid;
          preview = buildPreview(fileJson, title, null);
          // a file dropped over the results goes back to them, not to an empty search
          previewFrom = mode === "results" ? "results" : "start";
          mode = "preview";
        } catch (e) {
          error = `Couldn't read ${name}: ${String(e)}`;
          if (mode !== "results") mode = "start";
        }
        return;
      }

      if (payload.action === "home") { semitones = payload.semitones | 0; mode = "start"; return; }

      if (payload.action === "search") {
        query = payload.query || "";
        uploads = !!payload.uploads;
        try {
          await withProgress(
            "Searching…",
            async (upd) => {
              const names = ["Mutopia", ...(uploads ? ["BitMidi", "FreeMIDI"] : [])];
              await upd(`Searching ${names.join(", ")}…`, 20);
              // One search box. Mutopia (public domain) always; the
              // user-upload archives only when opted in.
              // Each is time-boxed so a slow or failed backend can't hold up the
              // results; whatever has arrived shows, the rest just don't appear
              // this time. Interleave so each present source is visible near
              // the top.
              const none = Promise.resolve([] as SearchRec[]);
              searchSeq++; pending = []; late = [];
              // Each source's outcome goes to the log (ExtensionHost.txt). A
              // source that fails has no rows; one that's slow is left running
              // in a live window (see `late`) and dropped in the reopening one.
              const timed = (name: string, p: Promise<SearchRec[]>) => {
                const t0 = Date.now();
                const logged = p.then(
                  (r) => { dbg(`search ${name}: ${r.length} results in ${Date.now() - t0} ms`); return r; },
                  (e) => { dbg(`search ${name} failed after ${Date.now() - t0} ms: ${why(e)}`); return [] as SearchRec[]; },
                );
                return withTimeout(logged, SEARCH_TIMEOUT_MS, null as SearchRec[] | null).then((r) => {
                  if (r === null) {
                    dbg(`search ${name}: no answer within ${SEARCH_TIMEOUT_MS} ms${live ? ", still waiting" : ""}`);
                    if (live) { pending.push(name); late.push({ name, rows: logged }); }
                  }
                  return r ?? [];
                });
              };
              const lists = await Promise.all([
                timed("Mutopia", searchMutopia(query)),
                uploads ? timed("BitMidi", searchBitmidi(query)) : none,
                uploads ? timed("FreeMIDI", searchFreemidi(query)) : none,
              ]);
              results = mergeInterleaved(lists);
              await prefetchIntros(results, upd);
            },
          );
          mode = "results"; selectedUid = null; intro = null;
        }
        catch (e) { error = "Search failed. " + why(e); dbg(error); mode = "start"; }
        return;
      }

      // In the background (a live window only): wait for the sources that were
      // still searching, then add their rows at the end of the list, so rows
      // already on screen don't move. Ignored if a newer search started.
      if (payload.action === "more") {
        if (payload.seq !== searchSeq || !late.length) return;
        const seq = searchSeq, waiting = late;
        late = [];
        const got = await Promise.all(waiting.map((l) => withTimeout(l.rows, LATE_TIMEOUT_MS, null as SearchRec[] | null)));
        if (seq !== searchSeq) return;   // a newer search took over meanwhile
        const have = new Set(results.map((r) => r.uid));
        const added = mergeInterleaved(got.map((g) => g ?? []), 1000).filter((r: SearchRec) => !have.has(r.uid));
        got.forEach((g, i) => { if (g === null) dbg(`search ${waiting[i].name}: gave up after ${LATE_TIMEOUT_MS} ms more`); });
        await prefetchIntros(added);
        results = [...results, ...added];
        pending = [];
        dbg(`search: ${added.length} late results added`);
        return;
      }

      if (payload.action === "back") { semitones = payload.semitones | 0; mode = previewFrom; return; }

      // Quick intro: load the selected song's first bars and play them inline in
      // the results view, before opening the full preview.
      if (payload.action === "quickload") {
        semitones = payload.semitones | 0;
        selectedUid = payload.uid;
        try {
          const rec = results.find((r) => r.uid === payload.uid);
          if (!rec) throw new Error("not in results");
          let json = "";
          await withProgress(
            "Loading…",
            async (upd) => { await upd("Fetching…", 55); json = await ensureNotesJson(rec); },
          );
          intro = { ...buildPreview(json, recLabel(rec), INTRO_BEATS), uid: payload.uid, autoplay: true };
        } catch (e) { error = "Load failed. " + why(e); dbg(error, payload.uid); intro = null; }
        mode = "results";
        return;
      }

      if (payload.action === "preview") {
        semitones = payload.semitones | 0;
        selectedUid = payload.uid;
        try {
          const rec = findRec(payload.uid);
          if (!rec) throw new Error("not in results");
          let json = "";
          await withProgress(
            "Loading preview…",
            async (upd) => { await upd("Fetching…", 40); json = await notesFor(rec); await upd("Rendering…", 85); },
          );
          preview = buildPreview(json, recLabel(rec), null);
          previewFrom = "results";
          mode = "preview";
        } catch (e) { error = "Preview failed. " + why(e); dbg(error, payload.uid); mode = "results"; }
        return;
      }
    }

    const server = await startWindowServer(page, async (payload) => { await act(payload); return state(); }, dbg)
      .catch((e) => { dbg("window server failed", String(e)); return null; });
    live = !!server;
    dbg(server ? `import window served at ${server.url.replace(/\?.*/, "")}` : "import window: reopening fallback");
    try {
      for (;;) {
        const url = server ? server.url : `data:text/html,${encodeURIComponent(page())}`;
        let payload: any = null;
        try { payload = JSON.parse(await context.ui.showModalDialog(url, 400, 420)); }
        catch { payload = null; } // closed with no result
        if (!payload || payload.action === "cancel") break;

        if (payload.action === "build") {
          semitones = payload.semitones | 0;
          selectedUid = payload.uid;
          try {
            const rec = findRec(payload.uid);
            if (!rec) throw new Error("not in results");
            const json = await notesFor(rec);
            await context.ui.withinProgressDialog(
              "Building into your Set…", { progress: 0 },
              async (upd) => { await build(json, semitones, recLabel(rec), upd); },
            );
            break; // success
          } catch (e) { error = "Build failed. " + why(e); dbg(error, payload.uid); mode = mode === "preview" ? "preview" : "results"; continue; }
        }
        // Only the reopening fallback sends other actions this way.
        await act(payload);
      }
    } finally {
      server?.close();
    }
  });

  for (const scope of SCOPES)
    context.ui.registerContextMenuAction(scope, "Import a song…", "tabridge.import");
}
