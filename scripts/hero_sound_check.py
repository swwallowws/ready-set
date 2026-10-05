"""Check the main page's hero bassline in headless Chrome (system Chrome): it plays through
spessasynth and the shared General MIDI bank (vendor/design/sound/gm.sf3) on a bass, it is
heard, and the pitch of what sounds follows the bar's curve (web/hero.js: the legato run,
the vibrato, the dive) within a few cents, at Transpose 0, at +5, and when Transpose moves
while the bar plays.

The synth's output is recorded in the page with an AudioWorklet stamped with the audio clock;
f0 comes from normalised autocorrelation over 40 ms windows and is compared, in cents, with
E2 + hero.pitchAt() + Transpose averaged over the same window. The recordings land in
spike/shots/hero-*.wav (gitignored) to listen to.

Serves web/ itself with scripts/serve.py's handler on a free port.

Run: tabridge/.venv/bin/python ready-set-public/scripts/hero_sound_check.py
"""

import base64
import importlib.util
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "spike" / "shots"

spec = importlib.util.spec_from_file_location("serve", ROOT / "scripts" / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)

failures = []


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what, flush=True)
    if not ok:
        failures.append(what)


# In the page: record one play of the bar and measure its pitch against the curve.
# `live`: [seconds into the bar, steps] presses ArrowUp on Transpose that many times then.
MEASURE = """async ({ live }) => {
  const H = await import('/hero.js');
  const hero = window.readySetHero;
  const { ctx, out } = hero.monitor();
  if (!window.__rec) {
    const code = `registerProcessor("rec", class extends AudioWorkletProcessor {
      constructor() { super(); this.buf = []; this.t0 = 0; }
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) { if (!this.buf.length) this.t0 = currentTime; this.buf.push(ch.slice()); }
        if (this.buf.length >= 32) { this.port.postMessage([this.t0, this.buf]); this.buf = []; }
        return true;
      }
    });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ctx, "rec");
    window.__rec = { node, blocks: [] };
    node.port.onmessage = (e) => window.__rec.blocks.push(e.data);
    out.connect(node);
    node.connect(ctx.destination);                     // outputs nothing, but stays pulled
  }
  window.__rec.blocks = [];
  const tr = document.getElementById('tr');
  const before = +tr.getAttribute('aria-valuenow');
  let changedAt = null, after = before;
  document.getElementById('play').click();
  while (!hero.playing || !hero.startedAt || hero.startedAt < ctx.currentTime - 1) await new Promise((ok) => setTimeout(ok, 5));
  const at = hero.startedAt;
  if (live) {
    while (ctx.currentTime < at + live[0]) await new Promise((ok) => setTimeout(ok, 2));
    for (let i = 0; i < live[1]; i++) {
      tr.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      tr.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }));
    }
    changedAt = ctx.currentTime - at;
    after = +tr.getAttribute('aria-valuenow');
  }
  while (ctx.currentTime < at + H.TOTAL + 0.4) await new Promise((ok) => setTimeout(ok, 20));
  const sr = ctx.sampleRate, blocks = window.__rec.blocks;
  const t0 = blocks[0][0];
  const total = blocks.reduce((n, [, b]) => n + b.length * 128, 0);
  const pcm = new Float32Array(Math.round((blocks.at(-1)[0] - t0) * sr) + total);
  for (const [t, bufs] of blocks) { let i = Math.round((t - t0) * sr); for (const b of bufs) { pcm.set(b, i); i += b.length; } }
  const idx = (songT) => Math.round((at + songT - t0) * sr);
  let peak = 0;
  for (let i = Math.max(0, idx(0)); i < Math.min(pcm.length, idx(H.TOTAL)); i++) peak = Math.max(peak, Math.abs(pcm[i]));

  const W = Math.round(0.04 * sr), minLag = Math.floor(sr / 400), maxLag = Math.ceil(sr / 35);
  function f0(songT) {
    const s = idx(songT) - (W >> 1);
    if (s < 0 || s + W + maxLag > pcm.length) return null;
    const r = [];
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0, e1 = 0, e2 = 0;
      for (let i = 0; i < W; i++) { const a = pcm[s + i], b = pcm[s + i + lag]; num += a * b; e1 += a * a; e2 += b * b; }
      r[lag] = num / Math.sqrt(e1 * e2 || 1);
      best = Math.max(best, r[lag]);
    }
    if (best < 0.5) return null;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (r[lag] > 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { bestLag = lag; break; }
    }
    if (!bestLag) return null;
    const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1];
    return sr / (bestLag + (a - c) / (2 * (a - 2 * b + c) || 1));
  }
  const settle = 0.08 + 0.03;                          // the scheduler's look-ahead, and a little
  const transposeAt = (t) => changedAt == null || t < changedAt ? before : t > changedAt + settle ? after : null;
  const groups = H.groups(), names = ['chug 1', 'ghost', 'chug 2', 'octave', 'legato run', 'vibrato', 'dive'];
  // the curve at t, averaged over the analysis window (semitones above E2, before Transpose)
  const want = (g, t) => { let s = 0; for (let k = -4; k <= 4; k++) s += H.pitchAt(g, t + k * 0.005); return s / 9; };
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
  const res = groups.map((g, gi) => {
    const pts = [];
    // a 28 ms glide is shorter than the 40 ms window: f0 cannot follow it, so windows that
    // touch one are left out (the run's range checks the steps land)
    const glides = g.segs.slice(1).map((n) => n.b * H.SPB);
    for (let t = g.start + 0.06; t <= g.end - 0.04; t += 0.01) {
      if (glides.some((st) => t + 0.02 > st && t - 0.02 < st + H.GLIDE)) continue;
      const tr0 = transposeAt(t - 0.02), tr1 = transposeAt(t + 0.02);
      if (tr0 == null || tr1 == null || tr0 !== tr1) continue;
      const hz = f0(t);
      if (hz) pts.push({ t, heard: 69 + 12 * Math.log2(hz / 440) - tr0 - H.BASE });
    }
    // the sample's own tuning: the note's median offset from the curve; what is left is how
    // closely the sound follows the curve's shape
    const tuning = med(pts.map((p) => (p.heard - want(g, p.t)) * 100));
    const abs = pts.map((p) => Math.abs((p.heard - want(g, p.t)) * 100 - tuning)).sort((a, b) => a - b);
    // how far the sound runs behind the curve: the shift that fits it best (on the notes
    // whose pitch keeps moving; a legato run is flat once its glides are left out)
    let lag = null;
    if (g.segs.some((n) => n.vib || n.bend)) {
      lag = { d: 0, rms: Infinity };
      for (let d = -0.03; d <= 0.0301; d += 0.001) {
        let s = 0;
        for (const p of pts) s += ((p.heard - want(g, p.t - d)) * 100 - tuning) ** 2;
        const rms = Math.sqrt(s / (pts.length || 1));
        if (rms < lag.rms) lag = { d: Math.round(d * 1000), rms };
      }
    }
    return { name: names[gi], n: abs.length, tuning, med: abs[abs.length >> 1] ?? null,
             p90: abs[Math.floor(abs.length * 0.9)] ?? null, max: abs.at(-1) ?? null, lag,
             lo: pts.length ? Math.min(...pts.map((p) => p.heard)) : null,
             hi: pts.length ? Math.max(...pts.map((p) => p.heard)) : null,
             first: pts.length ? pts[0].heard : null, firstWant: pts.length ? want(g, pts[0].t) : null,
             last: pts.at(-1)?.heard ?? null };
  });
  // 16-bit mono WAV of the bar, as base64
  const s0 = Math.max(0, idx(-0.05)), s1 = Math.min(pcm.length, idx(H.TOTAL + 0.35)), n = s1 - s0;
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, x) => [...x].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, sr, true); buf.setUint32(28, sr * 2, true);
  buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); str(36, 'data'); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[s0 + i])) * 32767, true);
  let bin = ''; const u8 = new Uint8Array(buf.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { peak, before, after, changedAt, res, wav: btoa(bin) };
}"""


def show(r):
    for g in r["res"]:
        if not g["n"]:
            print(f"    {g['name']:<11} no points")
            continue
        lag = f"; best fit {g['lag']['d']:+d} ms behind, rms {g['lag']['rms']:.1f} c" if g["lag"] else ""
        print(f"    {g['name']:<11} {g['n']:>3} points, tuning {g['tuning']:+.1f} c; |error| median {g['med']:.1f} c, "
              f"90th {g['p90']:.1f} c, max {g['max']:.1f} c; heard {g['lo']:+.2f}..{g['hi']:+.2f} st{lag}")


def report(label, r):
    print(f"  {label}: peak {r['peak']:.3f}")
    show(r)
    check(r["peak"] > 0.05, f"{label}: the bass is heard (peak {r['peak']:.3f})")
    measured = [g for g in r["res"] if g["n"]]
    check(len(measured) == 7, f"{label}: every note has a measured pitch ({len(measured)} of 7)")
    worst_tune = max(abs(g["tuning"]) for g in measured)
    check(worst_tune < 12, f"{label}: the samples sit in tune (worst {worst_tune:.1f} c, the bank's own tuning)")
    res = {g["name"]: g for g in r["res"]}
    curves = [res["legato run"], res["vibrato"], res["dive"]]
    worst = max(g["med"] for g in curves)
    check(all(g["med"] < 5 and g["p90"] < 15 for g in curves),
          f"{label}: pitch follows the legato run, the vibrato and the dive (median < 5 c, 90% < 15 c; worst median {worst:.1f} c)")
    moving = [g for g in curves if g["lag"]]
    check(all(abs(g["lag"]["d"]) <= 6 for g in moving),
          f"{label}: the vibrato and the dive keep time with the curve (best fits {', '.join(str(g['lag']['d']) for g in moving)} ms)")
    vib, dive, run = res["vibrato"], res["dive"], res["legato run"]
    check(0.7 < vib["hi"] - vib["lo"] < 0.9, f"{label}: the vibrato swings {100 * (vib['hi'] - vib['lo']):.0f} c (80 c written)")
    t = dive["tuning"] / 100
    check(abs(dive["last"] - t - (-6)) < 0.08 and abs(dive["first"] - t - dive["firstWant"]) < 0.08,
          f"{label}: the dive falls to {dive['last'] - t:+.2f} st (written -6), tuning aside")
    t = run["tuning"] / 100
    check(abs(run["lo"] - t - (-2)) < 0.08 and abs(run["hi"] - t - 1) < 0.08,
          f"{label}: the legato run spans {run['lo'] - t:+.2f}..{run['hi'] - t:+.2f} st (written -2, +1, -1), tuning aside")


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(serve.Handler, directory=str(serve.WEB_DIR)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True,
                                    args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        errors, requests = [], []
        page.on("console", lambda m: m.type == "error" and "favicon" not in (m.location or {}).get("url", "")
                and "site.json" not in (m.location or {}).get("url", "") and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: requests.append(r.url))
        page.goto(f"{base}/", wait_until="networkidle")

        # the first press loads the synth and plays; let it finish
        page.click("#play")
        page.wait_for_function("() => window.readySetHero.ready && window.readySetHero.playing", timeout=30000)
        check(True, "the first press loads the synth and plays")
        print(f"  synth clock offset {page.evaluate('() => window.readySetHero.clockOffset') * 1000:+.2f} ms")
        page.wait_for_function("() => document.getElementById('play').getAttribute('aria-pressed') === 'false'", timeout=10000)
        check(any("/vendor/design/sound/gm.sf3" in u for u in requests), "the shared gm.sf3 is what loads")
        check(any("/vendor/design/sound/spessasynth/spessasynth_lib.min.js" in u for u in requests),
              "the design system's spessasynth plays it")

        r = page.evaluate(MEASURE, {"live": None})
        (SHOTS / "hero-0.wav").write_bytes(base64.b64decode(r.pop("wav")))
        report("Transpose 0", r)

        page.focus("#tr")
        for _ in range(5):
            page.keyboard.press("ArrowUp")
        now = page.get_attribute("#tr", "aria-valuenow")
        check(now == "5", f"Transpose reads +5 ({now})")
        r = page.evaluate(MEASURE, {"live": None})
        (SHOTS / "hero-plus5.wav").write_bytes(base64.b64decode(r.pop("wav")))
        report("Transpose +5", r)

        # back to 0, then +3 while the bar plays (in the octave's vibrato note, 1.5 s in)
        for _ in range(5):
            page.keyboard.press("ArrowDown")
        r = page.evaluate(MEASURE, {"live": [1.5, 3]})
        (SHOTS / "hero-live.wav").write_bytes(base64.b64decode(r.pop("wav")))
        check(r["before"] == 0 and r["after"] == 3, f"Transpose moved {r['before']} -> {r['after']} at {r['changedAt']:.2f} s")
        print(f"  live Transpose: peak {r['peak']:.3f} (each note measured against the Transpose of its moment)")
        show(r)
        res = {g["name"]: g for g in r["res"]}
        check(all(g["med"] < 5 for g in r["res"] if g["n"]), "live Transpose: pitch follows the curve before and after")
        vib, dive = res["vibrato"], res["dive"]
        check(vib["n"] > 10 and abs(vib["tuning"]) < 12,
              f"live Transpose: the octave note already sounding moves up 3 with it ({vib['n']} points, off by {vib['tuning']:+.1f} c)")
        check(dive["n"] > 0 and abs(dive["tuning"]) < 12,
              f"live Transpose: the dive after it plays 3 semitones up (off by {dive['tuning']:+.1f} c)")

        page.wait_for_timeout(300)
        check(page.evaluate("() => window.readySetHero.peak()") < 0.001, "quiet once the bar has rung out")
        # Stop mid-bar goes quiet
        page.click("#play")
        page.wait_for_timeout(700)
        page.click("#play")
        page.wait_for_timeout(300)
        check(page.evaluate("() => window.readySetHero.peak()") < 0.001, "Stop mid-bar goes quiet")
        check(not any("jsdelivr" in u for u in requests), "nothing from a CDN")
        check(not errors, f"no console errors ({errors[:5]})")
        browser.close()
    httpd.shutdown()

    print("\nFAILED: " + "; ".join(failures) if failures else "\nALL PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
