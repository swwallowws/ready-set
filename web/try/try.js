// tabridge /try/: search a frozen public-domain catalogue by name, listen, and
// take it as an Ableton Live set or as MIDI. The catalogue (catalog/catalog.json + .mid files) is built by
// scripts/build_try_catalog.py, so the page is static: no proxy, no network
// search. Reading the MIDI, the roll, the preview player and the download use
// the same pieces as the main page (web/app.js).

import init, { midi_build_als, midi_build_notes_json, midi_transpose } from "../pkg/tabridge.js";
import { demoShell } from "../shared/vendor/design/demoshell.js";
import { valueBox } from "../shared/vendor/design/valuebox.js";
import { iconButton } from "../shared/vendor/design/iconbutton.js";
import { searchCatalog } from "./search.js";
import { midiPlayer, rollView, seekOnRoll, soundfontBytes } from "../shared/midiplay.js";

const $ = (id) => document.getElementById(id);
const HINTS = ["Greensleeves", "Bach", "Satie"];
const ROLL_BEATS = 32;   // the roll shows the opening eight bars (in 4/4)

// ---- demo shell: step rail beside the smallest live piece of the site ------------
const { rail } = demoShell($("demo"), {
  product: "Ready Set",
  title: "From a name to a set you can jam with.",
  intro: "Pick a public-domain piece, then bring it into Ableton Live or any music software.",
  steps: [
    { id: "search", label: "Type a name", hint: "Try one below" },
    { id: "pick", label: "Pick one", hint: "Starts right away" },
    { id: "take", label: "Take the set", hint: "Or the MIDI, for any music software" },
  ],
  // The rail's title stays a plain "Try it out!"; the way to the full version (the
  // website) comes at the end of the tour, as in every demo.
  endText: "That was the first step. ",
  onReset: resetDemo,
  // Space plays or stops the picked piece, the same as the player's own button; no legend.
  primary: { toggle: () => togglePlayback() },
});
// After the tour: the full version, in a new tab so the demo stays where it is.
{
  const full = Object.assign(document.createElement("a"), {
    className: "full-link", href: "../", target: "_blank", rel: "noopener", textContent: "Full version ↗",
  });
  document.querySelector(".steprail-end")?.append(full);
}

// ---- icon buttons: actions show a symbol, the word stays as label and tooltip ----
for (const id of ["clear-q", "search-go", "change-pick"]) iconButton($(id));

// ---- catalogue -----------------------------------------------------------------
let catalogue = null;
const catalogueReady = fetch("./catalog/catalog.json")
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((rows) => { catalogue = rows; })
  .catch(() => {
    setSearchStatus("Demo catalogue not found: run tabridge/.venv/bin/python tabridge/scripts/build_try_catalog.py");
  });
const wasmReady = init();

// ---- preview player: shared/midiplay.js, as on the main page ---------------------
// spessasynth with the design system's shared General MIDI bank, a play / stop /
// seek bar under the roll, and the roll following the playhead. The sounds start
// loading as the page opens, so the first pick plays quickly.
let pickGen = 0;          // bumped per pick; a superseded pick bails out
let current = null;       // { row, bytes, song }

const player = midiPlayer($("player-host"), {
  onPlay: () => rail.done("pick"),
  onTick: (t) => roll.draw(t == null ? null : player.beatAt(t)),
});
soundfontBytes().catch(() => { /* tried again on the first pick */ });
// for checks: is it heard, where is it
window.readySetPlayer = { peak: () => player.peak(), get time() { return player.time; },
                          get playing() { return player.playing; }, get beat() { return player.beatAt(player.time); },
                          get page() { return roll.page; }, get head() { return roll.head; } };

function stopPreview() { player.halt(); }
// Space (the shell's primary toggle): play or pause. The key press is a user
// gesture, so it unlocks audio like a click.
function togglePlayback() {
  if (!current || !player.loaded) return;
  player.toggle();
}

// ---- transpose: free play, not a rail step. Reuses midi_transpose (as on the
// main page's own transpose control, web/app.js), re-rendering the roll and
// rebuilding the preview + download on every step. ------------------------------
const trBox = valueBox($("transpose"), {
  min: -12, max: 12, value: 0, labelledBy: "transpose-label",
  format: (v) => (v > 0 ? "+" : "") + v,
  onChange: () => { setRollSong(); reloadPreview(); },
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
// the last one should touch the player. The new key plays on from the same
// moment when it was playing.
let previewGen = 0;
async function reloadPreview() {
  if (!current || !player.loaded) return;
  const gen = ++previewGen;
  const was = player.playing, at = player.time;
  player.unlock();
  try {
    await wasmReady;
    const bytes = midi_transpose(current.bytes, trBox.value);
    if (gen !== previewGen) return;
    if (!(await player.load(bytes)) || gen !== previewGen) return;
    if (was) player.play(at); else player.seek(at);
    setStatus(was && !audioIsOn() ? "Press play below (or Space) to hear it." : status0());
  } catch {
    if (gen !== previewGen) return;
    setStatus("Preview unavailable right now. The MIDI is still ready below.", true);
  }
}
const status0 = () => (player.playing ? "Playing. Pause or seek below." : "Ready. Press play below (or Space).");

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
// Audio is unlocked inside the click or key press itself (player.unlock()), before
// any await; where a browser still keeps it off, audioIsOn() says so plainly
// instead of the preview staying silent.
const audioIsOn = () => player.audioOn;

async function pick(r, el) {
  // Unlock audio inside the click itself, before any await.
  player.unlock();
  const gen = ++pickGen;
  previewGen++;
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
    setRollSong();

    setStatus("Loading sounds…");
    if (!(await player.load(bytes)) || gen !== pickGen) return;
    player.play(0);
    setStatus(audioIsOn() ? "Playing. Pause or seek below." : "Press play below (or Space) to hear it.");
    $("take").hidden = false;
    $("download").hidden = false;
    $("credit").textContent = r.credit;
  } catch (err) {
    if (gen !== pickGen) return;
    if (current) {
      // The MIDI is fine; only the preview player (or its sounds) failed.
      setStatus("Preview unavailable right now. The MIDI is still ready below.", true);
      $("take").hidden = false;
      $("download").hidden = false;
      $("credit").textContent = r.credit;
    } else {
      setStatus(`Couldn't load this one: ${err.message || err}`, true);
    }
  }
}

// ---- the roll: eight bars at a time, drawn with the shared TabridgeRoll, paging on
// with the playhead (shared/midiplay.js rollView) -------------------------------------
const roll = rollView($("roll"), { beats: ROLL_BEATS });
seekOnRoll($("roll"), roll, player);   // click or drag on the roll moves the playhead
function setRollSong() {
  if (!current || $("picked").hidden) return;
  roll.setSong(trBox.value === 0 ? current.song : JSON.parse(midi_build_notes_json(current.bytes, trBox.value)));
}
const rollBeat = () => (player.playing || player.time ? player.beatAt(player.time) : null);
window.addEventListener("resize", () => roll.draw(rollBeat()));
window.TabridgeRoll.onSchemeChange(() => roll.repaint());
document.fonts && document.fonts.ready.then(() => roll.repaint());

// ---- take the set or the MIDI ----------------------------------------------------------
// Both through the same writers the main page uses, at whatever transpose is
// currently dialled in (free play, not a rail step). Either one ticks the step.
const fileName = (ext) => `${[slug(current.row.artist), slug(current.row.title)].filter(Boolean).join("-") || "song"}.${ext}`;
$("download-set").addEventListener("click", async () => {
  if (!current) return;
  await wasmReady;
  downloadBytes(midi_build_als(current.bytes, trBox.value), fileName("als"));
  rail.done("take");
});
$("download").addEventListener("click", async () => {
  if (!current) return;
  await wasmReady;
  downloadBytes(midi_transpose(current.bytes, trBox.value), fileName("mid"));
  rail.done("take");
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
  previewGen++;
  player.stop();
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
