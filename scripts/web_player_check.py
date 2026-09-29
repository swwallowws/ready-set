"""Check the website's MIDI preview in headless Chrome (system Chrome): it plays
through spessasynth and the shared General MIDI bank, is heard (the player's
level meter, window.readySetPlayer.peak()), drums included, and the piano roll
follows the playhead (it pages on, and a seek moves it). Main page and /try/.

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
