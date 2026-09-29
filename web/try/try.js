// tabridge /try/: search a frozen public-domain catalogue by name, listen, and
// take the MIDI. The catalogue (catalog/catalog.json + .mid files) is built by
// scripts/build_try_catalog.py, so the page is static: no proxy, no network
// search. Reading the MIDI, the roll, the preview player and the download use
// the same pieces as the main page (web/app.js).

import init, { midi_build_notes_json, midi_transpose } from "../pkg/tabridge.js";
import { demoShell } from "../shared/vendor/design/demoshell.js";
import { valueBox } from "../shared/vendor/design/valuebox.js";
import { iconButton } from "../shared/vendor/design/iconbutton.js";
import { searchCatalog } from "./search.js";

const $ = (id) => document.getElementById(id);
const HINTS = ["Greensleeves", "Bach", "Satie"];
const ROLL_BEATS = 32;   // the roll shows the opening eight bars (in 4/4)

// ---- demo shell: step rail beside the smallest live piece of the site ------------
const { rail } = demoShell($("demo"), {
  product: "Ready Set",
  title: "From a name to MIDI in three clicks.",
  intro: "Pick a public-domain piece, then bring it into Ableton Live or any DAW.",
  steps: [
    { id: "search", label: "Type a name", hint: "Try one below" },
    { id: "pick", label: "Pick one", hint: "Starts right away" },
    { id: "midi", label: "Take the MIDI" },
  ],
  // Reads "The full version with the Ableton Live extension is here."
  full: { label: "version with the Ableton Live extension", href: "../" },
  endText: "Done. Try another name, or keep listening.",
  onReset: resetDemo,
  // Space plays or stops the picked piece, the same as the player's own button.
  primary: { toggle: () => togglePlayback(), label: "play" },
});

// ---- icon buttons: actions show a symbol, the word stays as label and tooltip ----
for (const id of ["clear-q", "search-go", "change-pick", "download"]) iconButton($(id));

// ---- catalogue -----------------------------------------------------------------
let catalogue = null;
const catalogueReady = fetch("./catalog/catalog.json")
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((rows) => { catalogue = rows; })
  .catch(() => {
    setSearchStatus("Demo catalogue not found: run tabridge/.venv/bin/python tabridge/scripts/build_try_catalog.py");
  });
const wasmReady = init();

// ---- preview player: html-midi-player, as on the main page -----------------------
// Loaded early (not on first pick) so the pick click can unlock audio right
// away. Tone is the same module instance html-midi-player plays through (its
// @magenta/music build imports this exact URL), so Tone.start() inside the
// click handler resumes the context the player uses.
const PLAYER_LIB = "https://cdn.jsdelivr.net/npm/html-midi-player@1.5.0/+esm";
const TONE_LIB = "https://cdn.jsdelivr.net/npm/tone@14.8.32/+esm";
let Tone = null;
const playerLib = Promise.all([import(PLAYER_LIB), import(TONE_LIB).then((m) => { Tone = m; })]);
playerLib.catch(() => { /* preview unavailable; the rest still works */ });

let player = null;
let previewUrl = null;
let pickGen = 0;          // bumped per pick; a superseded pick bails out
let current = null;       // { row, bytes, song }

async function ensurePlayer() {
  if (player) return player;
  await playerLib;
  player = document.createElement("midi-player");
  player.setAttribute("sound-font", "");
  player.addEventListener("start", () => rail.done("pick"));
  $("player-host").appendChild(player);
  return player;
}
function stopPreview() {
  if (player) { try { player.stop(); } catch { /* not ready */ } }
}
// Space (the shell's primary toggle): start or stop html-midi-player. The key
// press is a user gesture, so Tone.start() here unlocks audio like a click.
function togglePlayback() {
  if (!current || !player || !player.src) return;
  if (player.playing) { stopPreview(); return; }
  unlockAudio();
  Promise.resolve(player.start()).catch(() => {});
}

// ---- transpose: free play, not a rail step. Reuses midi_transpose (as on the
// main page's own transpose control, web/app.js), re-rendering the roll and
// rebuilding the preview + download on every step. ------------------------------
const trBox = valueBox($("transpose"), {
  min: -12, max: 12, value: 0, labelledBy: "transpose-label",
  format: (v) => (v > 0 ? "+" : "") + v,
  onChange: () => { drawRoll(); reloadPreview(); },
});
function resetTranspose() { trBox.set(0); }

// ---- collapsed list: once a piece is picked, the search list gives way to a
// single line naming it; "Change" or typing a new search brings the list back.
function collapseList() {
  $("search-list").hidden = true;
  $("picked-line").hidden = false;
}
function expandList() {
  $("picked-line").hidden = true;
  $("search-list").hidden = false;
}
$("change-pick").addEventListener("click", () => { expandList(); $("q").focus(); });
$("q").addEventListener("input", () => {
  if (!$("picked-line").hidden) expandList();
  syncClear();
});
// Clear: empties the search box (the pick and its player stay).
const syncClear = () => { $("clear-q").hidden = !$("q").value; };
$("clear-q").addEventListener("click", () => { $("q").value = ""; syncClear(); $("q").focus(); });

// Keyboard steps (and quick drags) fire "change" several times in a row; only
// the last one should touch the player, or a stale reload starts it after a
// newer one already has (the library logs "already playing" for that).
let previewGen = 0;
async function reloadPreview() {
  if (!current || !player) return;
  const gen = ++previewGen;
  stopPreview();
  try {
    await wasmReady;
    const bytes = midi_transpose(current.bytes, trBox.value);
    if (gen !== previewGen) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
    await new Promise((resolve) => {
      player.addEventListener("load", resolve, { once: true });
      player.src = previewUrl;
      setTimeout(resolve, 8000);
    });
    if (gen !== previewGen) return;
    Promise.resolve(player.start()).catch(() => {});
    setStatus(audioIsOn() ? "Playing. Pause or seek below." : "Press play below (or Space) to hear it.");
  } catch {
    if (gen !== previewGen) return;
    setStatus("Preview unavailable right now. The MIDI is still ready below.", true);
  }
}

// ---- search ----------------------------------------------------------------------
const setSearchStatus = (msg) => { $("search-status").textContent = msg; };
const setStatus = (msg, err = false) => { $("status").textContent = msg; $("status").classList.toggle("err", err); };

function chipButtons() {
  const box = document.createDocumentFragment();
  for (const h of HINTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = h;
    b.addEventListener("click", () => { $("q").value = h; syncClear(); runSearch(h); });
    box.append(b);
  }
  return box;
}
$("chips").append(chipButtons());

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch($("q").value);
});

async function runSearch(q) {
  q = String(q || "").trim();
  if (!q) return;
  await catalogueReady;
  if (!catalogue) return;
  const rows = searchCatalog(catalogue, q);
  const results = $("results");
  results.innerHTML = "";
  results.parentNode.querySelectorAll(".empty").forEach((n) => n.remove());
  if (!rows.length) {
    setSearchStatus("");
    // Empty state: say so, then offer the hints again (never an empty box).
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = `<p>Nothing here with that name. Try one of these:</p><div class="chips"></div>`;
    empty.querySelector(".chips").append(chipButtons());
    results.after(empty);
    return;
  }
  setSearchStatus(`${rows.length} result${rows.length === 1 ? "" : "s"}.`);
  for (const r of rows) results.append(renderResult(r));
  rail.done("search");
}

// Same markup and classes as renderResult() in web/app.js.
function renderResult(r) {
  const el = document.createElement("button");
  el.className = "result";
  el.type = "button";
  el.dataset.source = "mutopia";
  el.innerHTML =
    `<div class="rmain"><div class="t">${esc(r.artist ? `${r.artist} · ${r.title}` : r.title)}</div>` +
    `<div class="m">${esc(r.licence)}</div></div>` +
    `<span class="src">Mutopia</span>`;
  el.addEventListener("click", () => pick(r, el));
  return el;
}

// ---- pick: load, draw, play ---------------------------------------------------------
// Unlock audio inside a click or key press. If the pick comes before Tone has
// downloaded, start it the moment it arrives: browsers still count that as part
// of the gesture for a few seconds (Chrome), and audioIsOn() below says so
// plainly where they don't (Safari), instead of the preview staying silent.
function unlockAudio() {
  if (Tone) { try { Tone.start(); } catch { /* keep going */ } return; }
  playerLib.then(() => { try { Tone.start(); } catch { /* keep going */ } }, () => {});
}
function audioIsOn() {
  try { return !Tone || Tone.getContext().state === "running"; } catch { return true; }
}

async function pick(r, el) {
  // Unlock audio inside the click itself, before any await.
  unlockAudio();
  const gen = ++pickGen;
  stopPreview();
  document.querySelectorAll(".result.sel").forEach((n) => n.classList.remove("sel"));
  el.classList.add("sel");
  $("picked").hidden = false;
  $("take").hidden = true;
  $("download").hidden = true;
  $("picked-line-title").textContent = `${r.artist} · ${r.title}`;
  $("picked-line-meta").textContent = "";
  collapseList();
  setStatus("Loading…");
  current = null;
  resetTranspose();
  try {
    await wasmReady;
    const bytes = new Uint8Array(await (await fetch(r.file)).arrayBuffer());
    if (gen !== pickGen) return;
    const song = JSON.parse(midi_build_notes_json(bytes, 0));
    current = { row: r, bytes, song };
    const n = song.tracks.length;
    $("picked-line-meta").textContent = `${n} track${n === 1 ? "" : "s"} · ${r.licence}`;
    drawRoll();

    await ensurePlayer();
    if (gen !== pickGen) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
    await new Promise((resolve) => {
      player.addEventListener("load", resolve, { once: true });
      player.src = previewUrl;
      setTimeout(resolve, 8000); // safety net if "load" never fires
    });
    if (gen !== pickGen) return;
    Promise.resolve(player.start()).catch(() => {});
    setStatus(audioIsOn() ? "Playing. Pause or seek below." : "Press play below (or Space) to hear it.");
    $("take").hidden = false;
    $("download").hidden = false;
    $("credit").textContent = r.credit;
  } catch (err) {
    if (gen !== pickGen) return;
    if (current) {
      // The MIDI is fine; only the preview player (from a CDN) failed.
      setStatus("Preview unavailable right now. The MIDI is still ready below.", true);
      $("take").hidden = false;
      $("download").hidden = false;
      $("credit").textContent = r.credit;
    } else {
      setStatus(`Couldn't load this one: ${err.message || err}`, true);
    }
  }
}

// ---- the roll: the opening bars, drawn with the shared TabridgeRoll ---------------
const R = window.TabridgeRoll;
const canvas = $("roll"), ctx = canvas.getContext("2d");
let pal = null;
function drawRoll() {
  if (!current || $("picked").hidden) return;
  pal = pal || R.palette(document.documentElement);
  const dpr = Math.min(window.devicePixelRatio || 1, 2), box = canvas.getBoundingClientRect();
  canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height;
  const song = trBox.value === 0 ? current.song : JSON.parse(midi_build_notes_json(current.bytes, trBox.value));
  const notes = song.tracks.filter((t) => !t.isDrums).flatMap((t) => t.notes)
    .filter((n) => n.start < ROLL_BEATS);
  ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, W, H);
  if (!notes.length) return;
  const nlo = Math.min(...notes.map((n) => n.pitch)), nhi = Math.max(...notes.map((n) => n.pitch));
  let lo = nlo - 2, hi = nhi + 2;
  if (hi - lo < 24) { const pad = Math.ceil((24 - (hi - lo)) / 2); lo -= pad; hi += pad; }
  const row = H / (hi - lo + 1);
  const end = Math.max(...notes.map((n) => n.start + n.dur));
  const beats = Math.min(ROLL_BEATS, Math.max(8, Math.ceil(end / 4) * 4));
  R.bands(ctx, pal, 0, 0, W, lo, hi, row, true);
  ctx.fillStyle = pal.line;   // bar lines
  for (let b = 0; b <= beats; b += 4) ctx.fillRect(Math.round((b / beats) * W), 0, 1, H);
  for (const n of notes) {
    const x = (n.start / beats) * W, w = (Math.min(n.dur, beats - n.start) / beats) * W;
    R.note(ctx, pal, x, (hi - n.pitch) * row, w, row, R.shade(n.pitch, nlo, nhi), false);
  }
}
const repaint = () => { pal = null; drawRoll(); };
window.addEventListener("resize", drawRoll);
R.onSchemeChange(repaint);
document.fonts && document.fonts.ready.then(repaint);

// ---- take the MIDI ------------------------------------------------------------------
$("download").addEventListener("click", async () => {
  if (!current) return;
  await wasmReady;
  // Through the same MIDI writer the main page uses for .mid downloads, at
  // whatever transpose is currently dialled in (free play, not a rail step).
  const bytes = midi_transpose(current.bytes, trBox.value);
  const name = `${[slug(current.row.artist), slug(current.row.title)].filter(Boolean).join("-") || "song"}.mid`;
  downloadBytes(bytes, name);
  rail.done("midi");
});

// Same as downloadBytes() in web/app.js.
function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- start over -----------------------------------------------------------------------
function resetDemo() {
  pickGen++;
  stopPreview();
  current = null;
  resetTranspose();
  $("q").value = "";
  syncClear();
  $("results").innerHTML = "";
  document.querySelectorAll("#demo .empty").forEach((n) => n.remove());
  setSearchStatus("");
  expandList();
  $("picked").hidden = true;
  $("take").hidden = true;
  $("download").hidden = true;
  $("q").focus();
}

const esc = (s) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slug = (s) => (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
