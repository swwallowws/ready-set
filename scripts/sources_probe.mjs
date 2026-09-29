// Probe each search source through the running dev proxy and report how many
// rows the shared parser finds. Saves the raw FreeMIDI / Mutopia pages to
// spike/ for inspection when a parser comes back empty.
//
// Run: node scripts/sources_probe.mjs [port]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freemidiSearchUrl, mutopiaSearchUrl, normFreemidi, normMutopia, firstFreemidiArtist,
} from "../shared/sources.js";

const port = process.argv[2] || "8765";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "spike");
mkdirSync(out, { recursive: true });
const get = async (url) => {
  const res = await fetch(`http://localhost:${port}/proxy?url=${encodeURIComponent(url)}`);
  return { status: res.status, text: await res.text() };
};

for (const q of ["metallica nothing else matters", "metallica", "nothing else matters"]) {
  const { status, text } = await get(freemidiSearchUrl(q));
  writeFileSync(join(out, `freemidi-${q.replace(/\W+/g, "_")}.html`), text);
  console.log(`freemidi "${q}": HTTP ${status}, ${text.length} bytes, rows=${normFreemidi(text).length},`,
    "artist link:", firstFreemidiArtist(text), "| download3 links:", (text.match(/download3-/g) || []).length);
}
for (const q of ["bach", "chopin nocturne"]) {
  const { status, text } = await get(mutopiaSearchUrl(q));
  writeFileSync(join(out, `mutopia-${q.replace(/\W+/g, "_")}.html`), text);
  console.log(`mutopia "${q}": HTTP ${status}, ${text.length} bytes, rows=${normMutopia(text).length}`);
}
