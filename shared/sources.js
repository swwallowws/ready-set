// Source glue shared by the website (web/app.js) and the Ableton extension
// (extension/src/extension.ts): search-URL builders, result normalization, the
// merge, and labels. The heavy lifting (parsing tabs/MIDI/MusicXML, building
// notes/MIDI/.als) lives in the Rust core and is shared via WASM; this is the
// small JS layer around it. Kept pure: each surface injects its own fetch,
// since the browser goes through a relative /proxy and the extension host may
// fetch directly.
//
// Sources:
//   midi:      BitMidi MIDI archive, JSON API.
//   freemidi:  FreeMIDI archive, HTML scrape. Song search is thin, so we also
//               follow the top artist page to enumerate its songs. Downloads
//               need a two-step cookie handshake, done server-side by the proxy
//               (/freemidi?id=...); a bare fetch of the file 500s.
//   mutopia:   Mutopia Project, public-domain scores, HTML scrape. Search
//               returns pieces with direct .mid links (stateless download).

export const BITMIDI = "https://bitmidi.com";
export const FREEMIDI = "https://freemidi.org";
export const MUTOPIA = "https://www.mutopiaproject.org";

const LABELS = { midi: "BitMidi", freemidi: "FreeMIDI", mutopia: "Mutopia" };
export const srcLabel = (s) => LABELS[s] || s;
export const recLabel = (r) => (r.artist ? `${r.artist} · ${r.title}` : r.title);

export const bitmidiSearchUrl = (q) => `${BITMIDI}/api/midi/search?q=${encodeURIComponent(q)}`;
export const freemidiSearchUrl = (q) => `${FREEMIDI}/search?q=${encodeURIComponent(q)}`;
export const freemidiArtistPageUrl = (path) => `${FREEMIDI}/${path}`;
// FreeMIDI files come through the proxy's dedicated two-step endpoint, never a
// direct URL; the surface prefixes its own proxy base.
export const freemidiDownloadPath = (id) => `/freemidi?id=${encodeURIComponent(id)}`;
export const mutopiaSearchUrl = (q) => `${MUTOPIA}/cgibin/make-table.cgi?searchingfor=${encodeURIComponent(q)}`;

// A normalized result row: { source, id, uid, artist, title, tracks, ... }.
// uid ("<source>_<id>") is a collision-proof identity for a merged result set.
// tracks is a count, or null when unknown until the file is fetched.
// MIDI-bearing rows also carry either downloadUrl (direct) or freemidiId (proxy).

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, "")).trim();
const decodeEntities = (s) =>
  String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

export function normBitmidi(jsonOrText) {
  const data = typeof jsonOrText === "string" ? JSON.parse(jsonOrText) : jsonOrText;
  const recs = (data && data.result && data.result.results) || [];
  return recs.slice(0, 25).map((x) => {
    const name = String(x.name || "").replace(/\.mid$/i, "").trim();
    const dash = name.indexOf(" - ");
    const artist = dash > 0 ? name.slice(0, dash).trim() : "";
    const title = (dash > 0 ? name.slice(dash + 3) : name).trim() || "Untitled";
    return {
      source: "midi", id: x.id, uid: `midi_${x.id}`,
      artist, title, tracks: null, downloadUrl: `${BITMIDI}${x.downloadUrl}`,
    };
  });
}

// The first artist link on a FreeMIDI search page: { path, name }, or null.
// Following it lets an artist query ("metallica") enumerate that band's songs,
// since the search page itself only surfaces title matches.
export function firstFreemidiArtist(html) {
  const m = String(html || "").match(/href=["']?\/?(artist-\d+-[^"'\s>]+)["']?[^>]*>([^<]+)</i);
  return m ? { path: m[1], name: decodeEntities(m[2]).trim() } : null;
}

// FreeMIDI song links. Two layouts share one shape: the search page uses
//   <a href=download3-<id>-<slug> title="Title">Title</a>
// and an artist page uses
//   <a href=download3-<id>-<slug> itemprop=url> Title </a>
// so we take the song title from the anchor's inner text (present in both).
// `artistName` labels rows harvested from an artist page (the row has none).
export function normFreemidi(html, artistName = "") {
  const re = /<a\b[^>]*\bhref=["']?\/?download3-(\d+)-[^"'\s>]*["']?[^>]*>([\s\S]*?)<\/a>/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 25) {
    const id = m[1];
    if (seen.has(id)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    seen.add(id);
    out.push({
      source: "freemidi", id: Number(id), uid: `freemidi_${id}`,
      artist: artistName, title, tracks: null, freemidiId: id,
    });
  }
  return out;
}

// Mutopia pieces: one <table class="… result-table"> block each, holding a
// title, a "by <composer>" cell, a piece-info id, and a direct .mid link.
// Zip-only / preview-only rows (no .mid) are skipped.
export function normMutopia(html) {
  const blocks = String(html || "").split(/<table[^>]*result-table[^>]*>/i).slice(1);
  const out = [];
  for (const b of blocks) {
    if (out.length >= 25) break;
    const mid = b.match(/href="(https?:\/\/[^"]+\.mid)"/i);
    if (!mid) continue;
    const id = (b.match(/piece-info\.cgi\?id=(\d+)/i) || [])[1];
    const tds = [...b.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => stripTags(x[1]));
    const title = (tds[0] || "Untitled").trim() || "Untitled";
    const by = tds.find((t) => /^by\s+/i.test(t)) || "";
    // Drop the trailing life-dates parenthetical, e.g. "F. F. Chopin (1810–1849)".
    const artist = by.replace(/^by\s+/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    const key = id || String(out.length);
    out.push({
      source: "mutopia", id: id ? Number(id) : out.length, uid: `mutopia_${key}`,
      artist, title, tracks: null, downloadUrl: mid[1],
    });
  }
  return out;
}

// Interleave several result lists (round-robin) so every source shows near the
// top; cap the total. `lists` is an array of result arrays.
export function mergeInterleaved(lists, cap = 30) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out.slice(0, cap);
}
