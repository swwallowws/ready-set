"""Debug helper: click the demo's play button and report its state.

Run: .venv/bin/python scripts/web_debug_demo.py [port]
"""

import sys

from playwright.sync_api import sync_playwright

port = sys.argv[1] if len(sys.argv) > 1 else "8765"

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    page = b.new_page()
    page.on("console", lambda m: print("console:", m.type, m.text))
    page.on("pageerror", lambda e: print("pageerror:", e))
    page.goto(f"http://localhost:{port}/", wait_until="networkidle")
    print("before:", page.locator("#play").inner_text())
    page.click("#play")
    for ms in (50, 300, 1000):
        page.wait_for_timeout(ms)
        print(f"after {ms}ms:", page.locator("#play").inner_text(),
              page.evaluate("typeof audio !== 'undefined' && audio ? audio.state + ' t=' + audio.currentTime.toFixed(2) : 'no audio'"))
    b.close()
