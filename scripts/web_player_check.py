"""Check the website's MIDI preview in headless Chrome (system Chrome): it plays
through spessasynth and the shared General MIDI bank, is heard (the player's
level meter, window.readySetPlayer.peak()), drums included, and the piano roll
follows the playhead (it pages on, and a seek or a drag on the roll moves it).
After a drag is let go (playing or paused, a click, a flick, outside the window,
across a page turn, a lost capture) no frame draws the head back at the old place.
Main page and /try/.

Serves web/ itself with scripts/serve.py's handler on a free port, so no server
needs to be running. Test MIDI files and screenshots land in spike/shots/
(gitignored).

Run: .venv/bin/python scripts/web_player_check.py
"""

import importlib.util
import struct
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


# ---- tiny Standard MIDI File writer (format 0, 480 ticks per beat) ----------
def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append(0x80 | (n & 0x7F))
        n >>= 7
    return bytes(reversed(out))


def smf(bpm, notes, programs=()):
    """notes: (channel, pitch, velocity, start_beat, dur_beats)"""
    tpq = 480
    ev = [(0, bytes([0xFF, 0x51, 3]) + struct.pack(">I", round(60_000_000 / bpm))[1:])]
    for ch, prog in programs:
        ev.append((0, bytes([0xC0 | ch, prog])))
    for ch, p, v, s, d in notes:
        ev.append((round(s * tpq), bytes([0x90 | ch, p, v])))
        ev.append((round((s + d) * tpq) - 1, bytes([0x80 | ch, p, 0])))
    ev.sort(key=lambda e: (e[0], e[1][0] & 0xF0 == 0x90))
    body, last = b"", 0
    for t, data in ev:
        body += vlq(t - last) + data
        last = t
    body += b"\x00\xFF\x2F\x00"
    return b"MThd" + struct.pack(">IHHH", 6, 0, 1, tpq) + b"MTrk" + struct.pack(">I", len(body)) + body


def drums_only():
    # kick, snare, closed hat on channel 10 (index 9): eight bars of a rock beat at 120
    n = []
    for bar in range(8):
        for i in range(8):
            b = bar * 4 + i / 2
            n.append((9, 42, 90, b, 0.25))
            if i in (0, 4):
                n.append((9, 36, 120, b, 0.25))
            if i in (2, 6):
                n.append((9, 38, 115, b, 0.25))
    return smf(120, n)


def long_melody():
    # 48 beats of piano scale at 240 bpm (12 s): the roll must page on at beat 32
    scale = [60, 62, 64, 65, 67, 69, 71, 72]
    n = [(0, scale[i % 8], 100, i, 0.9) for i in range(48)]
    n += [(9, 36, 110, i, 0.25) for i in range(0, 48, 2)]
    return smf(240, n, programs=[(0, 0)])


def long_scale():
    # 128 beats of piano scale at 120 bpm (64 s, four roll pages): long enough to drag while playing
    scale = [60, 62, 64, 65, 67, 69, 71, 72]
    return smf(120, [(0, scale[i % 8], 100, i, 0.9) for i in range(128)], programs=[(0, 0)])


# ---- drag-release regression: the head must never show the old place after a let-go.
# spessasynth's Sequencer answers a new currentTime a frame or so later, so a player
# that drew seq.currentTime right after a seek drew the old place (one frame while
# playing, for good after a quick paused click). A mouse drag the browser cancels
# must also seek, not revert.
SAMPLER = """() => {
  window.__heads = [];
  const el = document.getElementById('preview-roll');
  el.addEventListener('pointerdown', e => { window.__pid = e.pointerId; });
  const f = () => { window.__heads.push([performance.now(), window.readySetPlayer.head]); requestAnimationFrame(f); };
  requestAnimationFrame(f);
}"""


def roll_beat(page_no, frac, span=32):
    """the beat a pointer at `frac` of the roll's width maps to (rollView.beatAt)"""
    frm = page_no * span
    b = frm + max(0.0, min(1.0, frac)) * span
    return min(frm + span - 0.01, max(frm + 0.01, b) if frm > 0 else b)


def drag_release(page, name, xs, *, steps=5, hold_ms=0, up_x=None, lose_capture=False):
    """press at xs[0] (a fraction of the roll's width), move through xs[1:], let go (at
    page pixel up_x if given); then every frame for 1 s must draw the head at the
    let-go beat, moving on at 2 beats/s when playing (120 bpm) once the output's delay has
    passed"""
    loc = page.locator("#preview-roll")
    loc.scroll_into_view_if_needed()
    b = loc.bounding_box()
    y = b["y"] + b["height"] / 2
    px = lambda f: b["x"] + b["width"] * f
    playing = page.evaluate("() => window.readySetPlayer.playing")
    page.mouse.move(px(xs[0]), y)
    page.mouse.down()
    for f in xs[1:]:
        page.mouse.move(px(f), y, steps=steps)
    if hold_ms:
        page.wait_for_timeout(hold_ms)
    pg = page.evaluate("() => window.readySetPlayer.page")
    frac = xs[-1]
    if up_x is not None:
        page.mouse.move(up_x, y, steps=steps)
        frac = (up_x - b["x"]) / b["width"]
    want = roll_beat(pg, frac)
    t0 = page.evaluate("() => performance.now()")
    if lose_capture:   # the browser drops the mouse's capture mid-drag: it ends there
        page.evaluate("() => document.getElementById('preview-roll').releasePointerCapture(window.__pid)")
    page.mouse.up()
    page.wait_for_timeout(1000)
    rate = 2.0 if playing else 0.0
    # playing, the head shows what is heard: it waits at the let-go beat for the output's delay
    delay = page.evaluate("() => window.readySetPlayer.delay") * 1000
    off = [(round(t - t0), h) for t, h in page.evaluate(f"() => window.__heads.filter(s => s[0] >= {t0})")
           if h is None or abs(h - (want + rate * max(0.0, t - t0 - delay) / 1000)) > 0.45]
    check(not off, f"main: {'playing' if playing else 'paused'}, {name}: the head stays at beat {want:.1f}"
          + (f" (off in {len(off)} frames: {off[:4]})" if off else ""))


def drag_checks(page, file):
    page.set_input_files("#file", str(file))
    page.wait_for_function("() => document.getElementById('status').textContent === 'Ready.'", timeout=20000)
    page.click("#preview")
    page.wait_for_function("() => window.readySetPlayer && window.readySetPlayer.playing", timeout=60000)
    page.evaluate(SAMPLER)
    slider = lambda frac: (page.eval_on_selector(
        "#preview-bar input[type=range]",
        f"el => {{ el.value = {round(frac * 1000)}; el.dispatchEvent(new Event('input', {{ bubbles: true }})); }}"),
        page.wait_for_timeout(250))
    vw = page.viewport_size["width"]
    for state in ("playing", "paused"):
        if state == "paused":
            page.locator("#preview-bar button").first.click()   # the play / pause toggle
            page.wait_for_timeout(200)
        slider(0.05)
        drag_release(page, "a click", [0.6], steps=1)
        slider(0.05)
        drag_release(page, "a drag", [0.2, 0.5])
        slider(0.05)
        drag_release(page, "a fast flick", [0.2, 0.8], steps=1)
        slider(0.05)
        drag_release(page, "let go right of the window", [0.4, 0.9], up_x=vw + 60)
        slider(0.24)   # beat ~31: held, the sound runs on into page 1 before the let-go on page 0
        drag_release(page, "held across a page turn", [0.9, 0.5], hold_ms=1200)
        slider(0.05)
        drag_release(page, "the capture lost mid-drag", [0.2, 0.7], lose_capture=True)


def wait_peak(page, what, timeout=15000):
    try:
        page.wait_for_function("() => window.readySetPlayer && window.readySetPlayer.peak() > 0.001",
                               timeout=timeout, polling=50)
        check(True, f"{what} is heard")
    except Exception:
        check(False, f"{what} is heard")
        return 0
    return max(page.evaluate("() => window.readySetPlayer.peak()") for _ in range(20))


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    drums = SHOTS / "check-drums.mid"
    melody = SHOTS / "check-melody.mid"
    drums.write_bytes(drums_only())
    melody.write_bytes(long_melody())
    longer = SHOTS / "check-long-scale.mid"
    longer.write_bytes(long_scale())

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(serve.Handler, directory=str(serve.WEB_DIR)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True,
                                    args=["--autoplay-policy=no-user-gesture-required"])
        ctx = browser.new_context(viewport={"width": 1200, "height": 900})
        page = ctx.new_page()
        errors, requests = [], []
        page.on("console", lambda m: m.type == "error" and "favicon" not in (m.location or {}).get("url", "")
                and "site.json" not in (m.location or {}).get("url", "") and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: requests.append(r.url))

        # ---- main page: drums only, then a long melody
        page.goto(f"{base}/", wait_until="networkidle")
        page.set_input_files("#file", str(drums))
        page.wait_for_function("() => document.getElementById('status').textContent === 'Ready.'", timeout=20000)
        page.click("#preview")
        page.wait_for_function("() => document.getElementById('status').textContent.startsWith('Preview ready')"
                               " || document.getElementById('status').classList.contains('err')", timeout=60000)
        check(page.inner_text("#status").startswith("Preview ready"), f"main: preview ready ({page.inner_text('#status')})")
        check(page.evaluate("() => window.readySetPlayer.playing"), "main: the preview plays")
        pk = wait_peak(page, "main: a drums-only file (channel 10)")
        print(f"  drums peak {pk:.3f}")
        check(any("/vendor/design/sound/gm.sf3" in u for u in requests), "main: the shared gm.sf3 is what loads")
        check(any("/vendor/design/sound/spessasynth/spessasynth_lib.min.js" in u for u in requests),
              "main: the design system's spessasynth is what plays it")
        check(not any("jsdelivr" in u for u in requests), "main: nothing from a CDN")
        page.screenshot(path=str(SHOTS / "player-main-drums.png"), full_page=True)

        page.set_input_files("#file", str(melody))
        page.wait_for_function("() => document.getElementById('status').textContent === 'Ready.'", timeout=20000)
        check(page.is_hidden("#player-host"), "main: a new file hides the old preview")
        page.click("#preview")
        page.wait_for_function("() => document.getElementById('status').textContent.startsWith('Preview ready')", timeout=60000)
        wait_peak(page, "main: piano and drums")
        b0 = page.evaluate("() => window.readySetPlayer.beat")
        page.wait_for_timeout(1500)
        b1 = page.evaluate("() => window.readySetPlayer.beat")
        check(b1 > b0 + 3, f"main: the playhead moves in beats ({b0:.1f} -> {b1:.1f} in 1.5 s at 240 bpm)")
        check(page.evaluate("() => window.readySetPlayer.page") == 0, "main: the roll starts on its first page")
        page.screenshot(path=str(SHOTS / "player-main-page0.png"), full_page=True)
        # seek to 75% (beat 36 of 48): the roll pages on with the playhead
        page.eval_on_selector("#preview-bar input[type=range]",
                              "el => { el.value = 750; el.dispatchEvent(new Event('input', { bubbles: true })); }")
        page.wait_for_timeout(300)
        b2 = page.evaluate("() => window.readySetPlayer.beat")
        check(b2 >= 35, f"main: seeking moves the playhead (beat {b2:.1f})")
        check(page.evaluate("() => window.readySetPlayer.page") == 1, "main: the roll follows it to the next page")
        page.screenshot(path=str(SHOTS / "player-main-page1.png"), full_page=True)
        page.click("#preview-bar button[aria-label=Stop]")
        page.wait_for_timeout(200)
        check(not page.evaluate("() => window.readySetPlayer.playing")
              and page.evaluate("() => window.readySetPlayer.time") == 0, "main: Stop stops and goes back to the start")
        page.wait_for_timeout(400)
        check(page.evaluate("() => window.readySetPlayer.peak()") < 0.001, "main: silent after Stop")
        # drag on the roll while stopped (page 0, 32 beats wide): press at a quarter, let go
        # at half. The place moves to beat 16, it stays stopped, the slider follows (16 of 48).
        box = page.locator("#preview-roll").bounding_box()
        y = box["y"] + box["height"] / 2
        page.mouse.move(box["x"] + box["width"] * 0.25, y)
        page.mouse.down()
        page.mouse.move(box["x"] + box["width"] * 0.5, y, steps=5)
        page.mouse.up()
        page.wait_for_timeout(200)
        bd = page.evaluate("() => window.readySetPlayer.beat")
        sv = int(page.eval_on_selector("#preview-bar input[type=range]", "el => el.value"))
        check(abs(bd - 16) < 0.5 and not page.evaluate("() => window.readySetPlayer.playing")
              and abs(sv - 333) <= 5, f"main: dragging on the roll moves the playhead (beat {bd:.1f}, slider {sv})")
        # ---- main page: many drags on a long file, playing and paused; the head never
        # shows the old place after a let-go
        drag_checks(page, longer)
        check(not errors, f"main: no console errors ({errors[:5]})")

        # ---- /try/: pick a catalogue piece, it plays, the roll follows
        errors.clear()
        requests.clear()
        page.goto(f"{base}/try/", wait_until="networkidle")
        page.click("#chips button")
        page.wait_for_selector(".result")
        page.click(".result")
        page.wait_for_function("() => window.readySetPlayer && window.readySetPlayer.playing", timeout=60000)
        pk = wait_peak(page, "/try/: the picked piece")
        print(f"  /try/ peak {pk:.3f}")
        b0 = page.evaluate("() => window.readySetPlayer.beat")
        page.wait_for_timeout(1200)
        b1 = page.evaluate("() => window.readySetPlayer.beat")
        check(b1 > b0, f"/try/: the playhead moves ({b0:.1f} -> {b1:.1f})")
        page.screenshot(path=str(SHOTS / "player-try.png"), full_page=True)
        page.eval_on_selector("#player-host input[type=range]",
                              "el => { el.value = 600; el.dispatchEvent(new Event('input', { bubbles: true })); }")
        page.wait_for_timeout(300)
        pg = page.evaluate("() => window.readySetPlayer.page")
        bt = page.evaluate("() => window.readySetPlayer.beat")
        check(pg == int(bt // 32), f"/try/: after a seek the roll shows the playhead's page (beat {bt:.1f}, page {pg})")
        page.screenshot(path=str(SHOTS / "player-try-seek.png"), full_page=True)
        page.keyboard.press("Space")
        page.wait_for_timeout(200)
        check(not page.evaluate("() => window.readySetPlayer.playing"), "/try/: Space pauses")
        page.keyboard.press("Space")
        page.wait_for_timeout(200)
        check(page.evaluate("() => window.readySetPlayer.playing"), "/try/: Space plays again")
        check(not any("jsdelivr" in u for u in requests), "/try/: nothing from a CDN")
        check(not errors, f"/try/: no console errors ({errors[:5]})")

        # ---- phone width: the bar fits
        phone = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
        phone.goto(f"{base}/try/", wait_until="networkidle")
        phone.click("#chips button")
        phone.wait_for_selector(".result")
        phone.click(".result")
        phone.wait_for_function("() => window.readySetPlayer && window.readySetPlayer.playing", timeout=60000)
        check(not phone.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "/try/: no sideways scroll on a phone")
        phone.screenshot(path=str(SHOTS / "player-try-phone.png"), full_page=True)
        browser.close()
    httpd.shutdown()

    print("\nFAILED: " + "; ".join(failures) if failures else "\nALL PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
