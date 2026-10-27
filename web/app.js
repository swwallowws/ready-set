// tabridge web UI: open your own MusicXML or MIDI file (or search online), build
// .als/.mid in WASM, download. Files are read locally and never uploaded.
// Fan-made MIDI sources (BitMidi, FreeMIDI) are opt-in, fine for practice but
// not for release; Mutopia (public domain) is always on.
//
// Mutopia and FreeMIDI send no CORS headers (and FreeMIDI needs a cookie
// handshake), so they go through a proxy; ./site.json says where it is.
// scripts/serve.py answers {proxy:true}: its own same-origin /proxy. The
// static build (scripts/deploy-web.sh, GitHub Pages) ships {proxy:"<base URL>"},
// the hosted ready-set-proxy. {proxy:false} or no site.json means no proxy:
// Mutopia is searched in the frozen /try/ catalogue and FreeMIDI is left out.
// BitMidi is always fetched directly (it allows any origin). All paths are
// relative so the page also works under a subpath.

import init, {
  musicxml_build_als,
  musicxml_build_als_with_template,
  musicxml_build_midi,
  musicxml_build_notes_json,
  midi_build_notes_json,
  midi_transpose,
  midi_build_als,
  midi_build_als_with_template,
  is_guitarpro,
  guitarpro_build_notes_json,
  guitarpro_build_midi,
  guitarpro_build_als,
  guitarpro_build_als_with_template,
} from "./pkg/tabridge.js";
import {
  bitmidiSearchUrl,
  freemidiSearchUrl, freemidiArtistPageUrl, freemidiDownloadPath,
  mutopiaSearchUrl,
  normBitmidi, normFreemidi, normMutopia,
  firstFreemidiArtist, srcLabel,
} from "./shared/sources.js";
import { searchCatalog } from "./try/search.js";
import { midiPlayer, rollView, seekOnRoll, zoomOnRoll } from "./shared/midiplay.js";
import { valueBox } from "./shared/vendor/design/valuebox.js";
import { iconButton, iconSvg } from "./shared/vendor/design/iconbutton.js";
import { outputDelay } from "./shared/vendor/design/playhead.js";

// What this host offers: { proxy, template }. `proxy` is the proxy's base URL
// ("./" for serve.py's same-origin proxy, "" for none). A missing or
// unreadable site.json counts as no proxy.
const proxyBase = (p) => {
  if (p === true) return "./";
  if (typeof p !== "string" || !p) return "";
  return p.endsWith("/") ? p : `${p}/`;
};
const site = fetch("./site.json")
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}))
  .then((s) => ({ proxy: proxyBase(s.proxy), template: !!s.template }));

const proxied = async (url) => `${(await site).proxy}proxy?url=${encodeURIComponent(url)}`;
const freemidiUrl = async (id) => `${(await site).proxy}${freemidiDownloadPath(id).replace(/^\//, "")}`;

const $ = (id) => document.getElementById(id);
const results = $("results");
const statusEl = $("status");
const searchStatusEl = $("search-status");

// The current source. MusicXML file: { kind:"musicxml", artist, title, xml }.
// MIDI (file or archive): { kind:"midi", artist, title, bytes }.
// Guitar Pro file: { kind:"guitarpro", artist, title, bytes }.
let selected = null;

const setStatus = (msg, err = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", err);
};
const setSearchStatus = (msg) => { searchStatusEl.textContent = msg; };

// Fan-made MIDI is opt-in (fine for practice, not for release); remember the choice.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
$("uploads").checked = store.get("tabridge-uploads") === "1";
$("uploads").addEventListener("change", (e) => store.set("tabridge-uploads", e.target.checked ? "1" : "0"));

// "Sources" disclosure: the list shows on hover or keyboard focus (CSS); a tap
// or click toggles it for touch, Escape or a tap elsewhere closes it.
{
  const box = $("srcs"), btn = $("srcs-btn");
  const set = (on) => { box.classList.toggle("open", on); btn.setAttribute("aria-expanded", String(on)); };
  btn.addEventListener("click", () => set(!box.classList.contains("open")));
  btn.addEventListener("keydown", (e) => { if (e.key === "Escape") { set(false); btn.blur(); } });
  document.addEventListener("pointerdown", (e) => { if (!box.contains(e.target)) set(false); });
}

// Without the proxy the Sources list says what this page can actually reach.
site.then(({ proxy }) => {
  if (proxy) return;
  $("src-mutopia").innerHTML = "<b>Mutopia</b> a public-domain selection, always searched";
  $("src-fan").innerHTML = "<b>BitMidi</b> fan-made MIDI, searched when included";
});

// Transpose: the design system's value box (-12..+12, default 0), like the hero's.
// The preview is built once at 0 and transposed live by the synth's key shift and
// the roll's shift, so a change is heard at once and the music never stops.
// Each newly opened piece starts at 0.
const transpose = valueBox($("semitones"), {
  min: -12, max: 12, value: 0, labelledBy: "semitones-label",
  format: (v) => (v > 0 ? "+" : "") + v,
  onChange: (v) => {
    if (!player || row) return;               // a row's preview stays at its own key
    player.setKeyShift(v);
    roll.setShift(v);
  },
});

// Optional Live template (web/template.als.xml): if present, .als exports clone
// its instruments/MPE; otherwise the built-in template is used, with a stock
// Drum Rack on drum parts and Tension on the rest.
let templateXml = null;
async function ready() {
  await init();
  // Only the local server can have a template (it's gitignored, never deployed),
  // so the static site doesn't ask for one.
  if (!(await site).template) return;
  try {
    const res = await fetch("./template.als.xml");
    if (res.ok) templateXml = await res.text();
  } catch { /* the built-in template */ }
}
const wasmReady = ready();

// Fetch + normalize via the shared source layer (also used by the extension).
// `direct` skips the proxy for sources that send CORS headers themselves.
const getText = async (url, direct = false) => {
  const res = await fetch(direct ? url : await proxied(url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};
const searchBitmidi = async (q) => normBitmidi(await getText(bitmidiSearchUrl(q), true));
// Live Mutopia search needs the proxy; without one the page searches the frozen
// /try/ catalogue instead (the same public-domain pieces the demo plays).
let catalogue = null;
const loadCatalogue = async () => {
  if (!catalogue) {
    const res = await fetch("./try/catalog/catalog.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalogue = await res.json();
  }
  return catalogue;
};
const searchMutopia = async (q) => {
  if ((await site).proxy) return normMutopia(await getText(mutopiaSearchUrl(q)));
  return searchCatalog(await loadCatalogue(), q).slice(0, 25).map((r) => ({
    source: "mutopia", id: r.uid, uid: r.uid, artist: r.artist, title: r.title,
    tracks: null, downloadUrl: `./try/${r.file}`, direct: true, credit: r.credit,
  }));
};
// FreeMIDI's search page mostly surfaces title matches; if that's thin, follow
// the top artist page to enumerate that artist's songs (the useful case for an
// artist query like "metallica").
const searchFreemidi = async (q) => {
  const html = await getText(freemidiSearchUrl(q));
  let recs = normFreemidi(html);
  if (recs.length < 5) {
    const artist = firstFreemidiArtist(html);
    if (artist) {
      try {
        const ahtml = await getText(freemidiArtistPageUrl(artist.path));
        const byId = new Map(recs.map((r) => [r.uid, r]));
        for (const r of normFreemidi(ahtml, artist.name)) byId.set(r.uid, r);
        recs = [...byId.values()];
      } catch { /* keep the title matches */ }
    }
  }
  return recs.slice(0, 25);
};

// Resolve to `fallback` if `p` doesn't settle within `ms`, so one slow source
// (FreeMIDI's multi-hop scrape) can't hold up the rest. Never rejects.
const withTimeout = (p, ms, fallback) =>
  Promise.race([p.catch(() => fallback), new Promise((res) => setTimeout(() => res(fallback), ms))]);
const SEARCH_TIMEOUT_MS = 6000;

// Client-side source filter, held in state so it survives the chip rebuilds as
// results stream in and applies to rows that arrive after a filter is picked.
let activeFilter = "all";
const seenSources = [];

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  closeRow();
  stopPreview();
  results.innerHTML = "";
  $("filters").innerHTML = "";
  showFilters(false);
  $("by-source").hidden = true;
  activeFilter = "all";
  seenSources.length = 0;
  const { proxy } = await site;
  // [label, search]: FreeMIDI only where the proxy can run its cookie handshake.
  const srcs = [["Mutopia", searchMutopia]];
  if ($("uploads").checked) {
    srcs.push(["BitMidi", searchBitmidi]);
    if (proxy) srcs.push(["FreeMIDI", searchFreemidi]);
  }
  const fns = srcs.map(([, fn]) => fn);
  setSearchStatus(`Searching ${srcs.map(([name]) => name).join(", ")}…`);

  let total = 0, pending = fns.length;
  // Render each source the moment it resolves. Rows are appended, so existing
  // rows and the scroll position never move (no jank), and a slow or failed
  // source can't hold up the ones that already answered.
  const arrive = (recs) => {
    pending -= 1;
    for (const r of recs || []) {
      if (!seenSources.includes(r.source)) seenSources.push(r.source);
      renderResult(r);
      total += 1;
    }
    if (recs && recs.length) rebuildFilters();
    setSearchStatus(pending > 0
      ? (total ? `${total} result${total === 1 ? "" : "s"} so far…` : "Searching…")
      : (total ? `${total} result${total === 1 ? "" : "s"}.` : "No results."));
  };
  Promise.all(
    fns.map((fn) =>
      withTimeout(fn(q), SEARCH_TIMEOUT_MS, []).then(arrive)),
  );
});

function renderResult(r) {
  const item = document.createElement("div");
  item.className = "row-item";
  item.dataset.source = r.source;
  const el = document.createElement("button");
  el.className = "result";
  el.type = "button";
  // the source, and the track count once it's known: no "MIDI file" line
  const src = srcLabel(r.source) + (r.tracks != null ? ` · ${r.tracks} track${r.tracks === 1 ? "" : "s"}` : "");
  el.innerHTML =
    `<div class="rmain"><div class="t">${esc(r.artist ? `${r.artist} · ${r.title}` : r.title)}</div></div>` +
    `<span class="src">${esc(src)}</span><span class="go">${iconSvg("chevron", { dir: "right" })}</span>`;
  el.setAttribute("aria-label", `Open ${r.artist ? `${r.artist}, ${r.title}` : r.title}`);
  el.addEventListener("click", () => pick(r, item));
  // hear it here, without opening it: play, and a small roll under the row
  const play = iconButton({ icon: "play", toggle: true, label: `Play ${r.title}`, size: "s",
    onPress: (on) => rowPlay(r, item, play, on) });
  item.append(play.el, el);
  // Rows that stream in after a filter is picked start hidden if they don't match.
  item.style.display = (activeFilter === "all" || r.source === activeFilter) ? "" : "none";
  results.appendChild(item);
}

// Filtering by source, only when asked for: "by source" beside the count (once more than
// one source has answered) opens a line of plain words; closing it shows every source again.
// Rebuilt as sources stream in; the active filter lives in state, so it survives the
// rebuild and keeps applying to rows that arrive later.
function showFilters(on) {
  $("filters").hidden = !on;
  $("by-source").setAttribute("aria-expanded", String(on));
  if (!on && activeFilter !== "all") { activeFilter = "all"; applyFilter(); }
}
$("by-source").addEventListener("click", () => showFilters($("filters").hidden));
function rebuildFilters() {
  const box = $("filters");
  box.innerHTML = "";
  $("by-source").hidden = seenSources.length < 2;
  if (seenSources.length < 2) return;
  for (const [f, label] of [["all", "All"], ...seenSources.map((s) => [s, srcLabel(s)])]) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.filter = f;
    b.setAttribute("aria-pressed", String(f === activeFilter));
    b.textContent = label;
    b.onclick = () => { activeFilter = f; applyFilter(); };
    box.appendChild(b);
  }
}

function applyFilter() {
  $("filters").querySelectorAll("button").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.filter === activeFilter)));
  results.querySelectorAll(".row-item").forEach((el) => {
    el.style.display = (activeFilter === "all" || el.dataset.source === activeFilter) ? "" : "none";
  });
}

// Fetch the .mid bytes for a MIDI-bearing result. FreeMIDI goes through the
// proxy's two-step endpoint; live Mutopia files go through the proxy; BitMidi
// (any origin allowed) and catalogue rows (files on this site) go direct.
const bytesFor = new Map();       // uid -> the file's bytes, fetched once per search
async function fetchMidiBytes(r) {
  if (bytesFor.has(r.uid)) return bytesFor.get(r.uid);
  const { proxy } = await site;
  const url = r.source === "freemidi" ? await freemidiUrl(r.freemidiId)
    : (r.direct || r.source === "midi" || !proxy) ? r.downloadUrl : await proxied(r.downloadUrl);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  bytesFor.set(r.uid, bytes);
  return bytes;
}

// A row's play button: the piece from its start in the shared player, a small roll under
// the row following it. One row at a time; opening a piece or a new search closes it.
let row = null;                   // { uid, item, btn, canvas }
function closeRow() {
  if (!row) return;
  if (player) player.halt();
  row.canvas.remove();
  row.btn.setPressed(false);
  row = null;
  activeRoll = roll;
}
async function rowPlay(r, item, btn, on) {
  if (row && row.uid === r.uid) {             // the same row: pause, or go on
    if (on) player.play(); else player.pause();
    return;
  }
  closeRow();
  ensurePlayer().unlock();                    // inside the click, before any await
  const canvas = document.createElement("canvas");
  canvas.className = "iroll";
  item.append(canvas);
  const mine = { uid: r.uid, item, btn, canvas };
  row = mine;
  try {
    await wasmReady;
    const bytes = await fetchMidiBytes(r);
    if (row !== mine) return;
    const mini = rollView(canvas, { beats: 16 });
    mini.setSong(JSON.parse(midi_build_notes_json(bytes, 0)));
    seekOnRoll(canvas, mini, player);
    activeRoll = mini;
    player.setKeyShift(0);                    // a row plays in the piece's own key
    if (!(await player.load(bytes)) || row !== mine) return;
    player.play(0);
  } catch (err) {
    if (row === mine) { closeRow(); setSearchStatus(`Couldn't play it: ${err.message || err}`); }
  }
}

// Find, hear, take: picking a result or a file folds the search away, shows what
// was picked and plays it at once; the downloads come after it. The search icon
// on the picked line brings the results back.
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const songMeta = (song) => [song.tempo ? `${Math.round(song.tempo)} BPM` : "", plural(song.tracks.length, "track")].filter(Boolean).join(" · ");
function openPicked(title, back) {
  closeRow();
  stopPreview();
  ensurePlayer().unlock();                  // inside the click, so the preview can sound when it's ready
  activeRoll = roll;
  transpose.set(0);                         // a new piece starts in its own key
  $("change-pick").textContent = back;
  $("find").hidden = true;
  $("picked").hidden = false;
  $("picked-title").textContent = title;
  $("picked-meta").textContent = "";
  $("credit").textContent = "";
  $("take").hidden = true;
}
function backToFind() {
  stopPreview();
  selected = null;
  $("picked").hidden = true;
  $("find").hidden = false;
  setStatus("");
  $("q").focus();
}
$("change-pick").addEventListener("click", backToFind);

// Where it's from and under what terms. The heading already names the piece, so the credit
// doesn't: the catalogue's own credit loses its leading "<title> by <composer>, ".
function creditFor(r) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  if (r.credit) {
    const lead = `${r.title}${r.artist ? ` by ${r.artist}` : ""}, `;
    return cap(r.credit.startsWith(lead) ? r.credit.slice(lead.length) : r.credit);
  }
  if (r.source === "mutopia") return "From the Mutopia Project, public domain";
  return `Fan-made MIDI from ${srcLabel(r.source)}: fine for practice, not for release`;
}

async function pick(r, item) {
  document.querySelectorAll(".row-item.sel").forEach((n) => n.classList.remove("sel"));
  item.classList.add("sel");
  openPicked(r.artist ? `${r.artist} · ${r.title}` : r.title, "← results");
  setStatus("Loading…");
  try {
    await wasmReady;
    // Every online source yields a .mid; fetch + summarize it.
    const bytes = await fetchMidiBytes(r);
    selected = { kind: "midi", artist: r.artist, title: r.title, bytes };
    try { $("picked-meta").textContent = songMeta(JSON.parse(midi_build_notes_json(bytes, 0))); } catch { /* no meta */ }
    $("credit").textContent = creditFor(r);
    await loadPreview();
  } catch (err) {
    setStatus(`Couldn't load: ${err}`, true);
  }
}

// Build output bytes for the current source, in the requested format ("mid" or
// "als"). Branches on the source kind so Preview and Download share one path.
async function buildBytes(format, semitones) {
  await wasmReady;
  if (selected.kind === "midi") {
    // MIDI source: .mid is a direct transpose; .als is built via the flat,
    // beat-based writer (notes at absolute beats, marker-derived scenes).
    if (format === "mid") return midi_transpose(selected.bytes, semitones);
    if (templateXml) return midi_build_als_with_template(selected.bytes, semitones, templateXml);
    return midi_build_als(selected.bytes, semitones);
  }
  if (selected.kind === "guitarpro") {
    if (format === "mid") return guitarpro_build_midi(selected.bytes, semitones);
    if (templateXml) return guitarpro_build_als_with_template(selected.bytes, semitones, templateXml);
    return guitarpro_build_als(selected.bytes, semitones);
  }
  if (format === "mid") return musicxml_build_midi(selected.xml, semitones);
  if (templateXml) return musicxml_build_als_with_template(selected.xml, semitones, templateXml);
  return musicxml_build_als(selected.xml, semitones);
}

// ---- Your own file (self-contained; no network) ----------------------------
// Read a MusicXML, MIDI or Guitar Pro file the user picked or dropped and make
// it the current source. MuseScore and most score editors export MusicXML;
// uncompressed .xml/.musicxml only (not .mxl). MIDI and Guitar Pro are sniffed
// from their bytes, so a misnamed file still works.
async function pickFile(file) {
  if (!file) return;
  document.querySelectorAll(".row-item.sel").forEach((n) => n.classList.remove("sel"));
  openPicked(file.name.replace(/\.(musicxml|xml|midi?|mxl|gpx?|gp[345])$/i, ""), "← back");
  setStatus("Reading the file…");
  try {
    await wasmReady;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isMidi = bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === "MThd";
    const title = file.name.replace(/\.(musicxml|xml|midi?|mxl|gpx?|gp[345])$/i, "");
    let song, kind;
    if (isMidi) {
      // A MIDI file already opens in Ableton Live: drag it into a set. Ready Set is for what
      // Live can't open. (Search results still arrive as MIDI and become a set.)
      throw new Error("MIDI files open in Ableton Live directly: drag one into your set. Ready Set takes Guitar Pro and MusicXML files");
    } else if (is_guitarpro(bytes)) {
      kind = "Guitar Pro";
      selected = { kind: "guitarpro", artist: "", title, bytes };
      song = JSON.parse(guitarpro_build_notes_json(bytes, 0));
    } else if (/\.mxl$/i.test(file.name)) {
      throw new Error("compressed .mxl isn't supported yet; export uncompressed MusicXML (.musicxml)");
    } else {
      kind = "MusicXML";
      const xml = new TextDecoder().decode(bytes);
      selected = { kind: "musicxml", artist: "", title, xml };
      // Validate + summarize by parsing once (throws on bad input).
      song = JSON.parse(musicxml_build_notes_json(xml, 0));
    }
    $("picked-meta").textContent = `${kind} · ${songMeta(song)}`;
    await loadPreview();
  } catch (err) {
    selected = null;
    const msg = String(err.message || err);
    // A MIDI file was read fine; it just isn't what Ready Set is for: say only that.
    setStatus(msg.startsWith("MIDI files") ? `${msg}.` : `Couldn't read ${file.name}: ${msg}`, true);
  }
}

// Drag and drop onto the drop zone (the whole zone is also a <label> for the
// hidden file input, so a click opens the picker).
const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "dragend"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  pickFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});

// The downloads: an Ableton Live set, or MIDI, at the transpose you hear.
async function take(format, btn) {
  if (!selected) return;
  const semitones = transpose.value;
  btn.disabled = true;
  try {
    const bytes = await buildBytes(format, semitones);
    const stem = [slug(selected.artist), slug(selected.title)].filter(Boolean).join("-") || "song";
    const name = `${stem}${semitones ? `_${semitones > 0 ? "+" : ""}${semitones}st` : ""}.${format}`;
    downloadBytes(bytes, name);
    setStatus("");
  } catch (err) {
    setStatus(`Build failed: ${err}`, true);
  } finally {
    btn.disabled = false;
  }
}
$("download-set").addEventListener("click", (e) => take("als", e.currentTarget));
$("download").addEventListener("click", (e) => take("mid", e.currentTarget));

// ---- Preview: render the .mid in-browser and play it --------------------------
// shared/midiplay.js: spessasynth with the design system's shared General MIDI
// bank (the same sounds as every other tool here), a small play / stop / seek
// bar, and a piano roll that follows the playhead. Everything is vendored, so
// nothing loads from a CDN.
let player = null;        // midiPlayer, made on the first Preview
let roll = null;          // rollView over #preview-roll
let activeRoll = null;    // the roll the playhead draws on: the open piece's, or a row's
let previewGen = 0;       // bumped per render; makes superseded renders bail out

// Stop any playing preview and hide the player. Bumping previewGen also makes
// any in-flight render bail before it can start audio for the old selection.
function stopPreview() {
  previewGen++;
  if (player) player.halt();
  $("player-host").hidden = true;
}

function ensurePlayer() {
  if (player) return player;
  roll = rollView($("preview-roll"), { scrollbar: $("preview-scroll") });
  activeRoll = roll;
  player = midiPlayer($("preview-bar"), {
    onTick: (t) => activeRoll && activeRoll.draw(t == null ? null : player.beatAt(t)),
    onStop: () => { if (row && !player.playing) row.btn.setPressed(false); },
    onPlay: () => { if (row) row.btn.setPressed(true); },
  });
  seekOnRoll($("preview-roll"), roll, player);  // click or drag on the roll moves the playhead
  zoomOnRoll($("preview-roll"), roll);          // pinch or ⌘ + scroll zooms, a double-click shows it all
  window.addEventListener("resize", () => roll.draw(player.playing || player.time ? player.beatAt(player.time) : null));
  window.addEventListener("tabridge-theme", () => roll.repaint());
  window.TabridgeRoll.onSchemeChange(() => roll.repaint());
  // for checks: is it heard, where is it
  window.readySetPlayer = { peak: () => player.peak(), get time() { return player.time; },
                            get delay() { return outputDelay(player.ctx); },   // what the head trails the sound by
                            get playing() { return player.playing; }, get beat() { return player.beatAt(player.time); },
                            get page() { return roll.page; }, get head() { return roll.head; },
                            get span() { return roll.span; }, get whole() { return roll.whole; },
                            get from() { return roll.from; } };
  return player;
}

// Build the .mid in the piece's own key, load it into the player and start
// playback; Transpose is applied live on top (see `transpose`). The `previewGen`
// token makes a superseded render ignore its own async callbacks so rapid
// re-renders can't race.
async function loadPreview() {
  const myGen = ++previewGen;
  ensurePlayer().unlock();                  // inside the click, before any await
  try {
    if ($("player-host").hidden) setStatus("Loading…");
    const bytes = await buildBytes("mid", 0);
    if (myGen !== previewGen) return;
    player.setKeyShift(transpose.value);
    if (!(await player.load(bytes)) || myGen !== previewGen) return;
    $("player-host").hidden = false;
    $("take").hidden = false;
    roll.setSong(JSON.parse(midi_build_notes_json(bytes, 0)));
    roll.setShift(transpose.value);
    player.play(0);
    setStatus("");
  } catch (err) {
    if (myGen === previewGen) setStatus(`Preview failed: ${err.message || err}`, true);
  }
}

$("file").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  pickFile(file);
  e.target.value = ""; // let the same file be re-picked
});

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const esc = (s) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slug = (s) => (s || "song").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
