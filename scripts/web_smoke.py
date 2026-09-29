"""Smoke-test the website end to end in headless Chrome (system Chrome, no
browser download). Needs scripts/serve.py running.

Covers: page load without console errors, the demo roll, a live search, picking
a result, building a .mid and an .als, the in-browser preview, and a MusicXML
file import. Screenshots land in spike/shots/ (gitignored).

Run: .venv/bin/python scripts/web_smoke.py [port] [query]
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "spike" / "shots"
SAMPLE = ROOT / "tests" / "data" / "sample.musicxml"
GP_SAMPLE = SHOTS / "sample.gp"

port = sys.argv[1] if len(sys.argv) > 1 else "8765"
query = sys.argv[2] if len(sys.argv) > 2 else "duman elleri ellerime"
URL = f"http://localhost:{port}/"

failures = []


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what, flush=True)
    if not ok:
        failures.append(what)


def status(page):
    return page.locator("#status").inner_text()


def wait_status(page, done, timeout=45000, sel="#status"):
    """Wait until the status line matches one of `done` (or reports an error)."""
    page.wait_for_function(
        """([sel, done]) => { const s = document.querySelector(sel);
             return s && (s.classList.contains('err') || done.some(d => s.textContent.includes(d))); }""",
        arg=[sel, done], timeout=timeout)
    return page.locator(sel).inner_text()


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True,
                                    args=["--autoplay-policy=no-user-gesture-required"])
        for scheme in ("light", "dark"):
            ctx = browser.new_context(color_scheme=scheme, viewport={"width": 1200, "height": 900},
                                      accept_downloads=True)
            page = ctx.new_page()
            page.goto(URL, wait_until="networkidle")
            page.screenshot(path=str(SHOTS / f"home-{scheme}.png"), full_page=True)
            ctx.close()
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle")
        page.screenshot(path=str(SHOTS / "home-phone.png"), full_page=True)
        overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
        check(not overflow, "no horizontal scroll at phone width")
        ctx.close()

        ctx = browser.new_context(viewport={"width": 1200, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: m.type == "error" and "favicon" not in (m.location or {}).get("url", "")
                and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="networkidle")

        # Demo roll plays and transposes.
        page.click("#play")
        page.wait_for_timeout(600)
        check("stop" in page.locator("#play").inner_text().lower(), "demo plays")
        page.click("#play")

        # Your own file first: MusicXML, then check the user-upload opt-in is off.
        page.set_input_files("#file", str(SAMPLE))
        st = wait_status(page, ["Ready."])
        check(st == "Ready.", f"MusicXML file import ({st})")
        page.select_option("#format", "mid")
        with page.expect_download(timeout=30000) as dl:
            page.click("#download")
        mid_path = SHOTS / "sample-from-musicxml.mid"
        dl.value.save_as(str(mid_path))
        check(mid_path.stat().st_size > 20, "MusicXML -> .mid download")
        # ...and that .mid back in as a MIDI file.
        page.set_input_files("#file", str(mid_path))
        st = wait_status(page, ["Ready."])
        check(st == "Ready." and "MIDI" in page.locator("#picked-info").inner_text(), f"MIDI file import ({st})")
        page.select_option("#format", "als")
        with page.expect_download(timeout=30000) as dl:
            page.click("#download")
        check(dl.value.suggested_filename.endswith(".als"), "MIDI file -> .als download")
        # Guitar Pro 7 (write it first: cargo run --example write_sample_gp -- spike/shots/sample.gp).
        if GP_SAMPLE.exists():
            page.set_input_files("#file", str(GP_SAMPLE))
            st = wait_status(page, ["Ready."])
            check(st == "Ready." and "Guitar Pro" in page.locator("#picked-info").inner_text(),
                  f"Guitar Pro file import ({st})")
            for fmt in ("als", "mid"):
                page.select_option("#format", fmt)
                with page.expect_download(timeout=30000) as dl:
                    page.click("#download")
                check(dl.value.suggested_filename.endswith("." + fmt), f"Guitar Pro -> .{fmt} download")
        else:
            check(False, f"Guitar Pro sample missing at {GP_SAMPLE}")

        # Online search: collapsed by default, fan-made MIDI opt-in.
        check(not page.locator("#online").evaluate("d => d.open"), "online search collapsed by default")
        page.click("#online > summary")
        check(not page.locator("#uploads").is_checked(), "fan-made MIDI off by default")
        page.check("#uploads")
        page.fill("#q", query)
        page.click("#search-form button[type=submit]")
        st = wait_status(page, ["result.", "results.", "No results."], timeout=30000, sel="#search-status")
        n = page.locator(".result").count()
        check(n > 0, f"search '{query}' returned rows ({n}; status: {st})")
        sources = page.eval_on_selector_all(".result", "els => [...new Set(els.map(e => e.dataset.source))]")
        print("  sources answered:", sources)

        if n:
            page.locator(".result").first.click()
            st = wait_status(page, ["Ready."])
            check(st == "Ready.", f"pick first result ({st})")
            page.screenshot(path=str(SHOTS / "picked.png"), full_page=True)

            for fmt in ("mid", "als"):
                page.select_option("#format", fmt)
                with page.expect_download(timeout=60000) as dl:
                    page.click("#download")
                d = dl.value
                path = SHOTS / d.suggested_filename
                d.save_as(str(path))
                check(path.stat().st_size > 100, f"download .{fmt} ({d.suggested_filename}, {path.stat().st_size} bytes)")

            page.click("#preview")
            st = wait_status(page, ["Preview ready"], timeout=60000)
            check(st.startswith("Preview ready"), f"preview ({st})")
            page.screenshot(path=str(SHOTS / "preview.png"), full_page=True)

        # Mode switch repaints: Night then back to System.
        page.click(".modes button[data-mode=night]")
        check(page.evaluate("document.documentElement.dataset.theme") == "night", "Night mode applies")
        page.screenshot(path=str(SHOTS / "night-after-use.png"), full_page=True)
        page.click(".modes button[data-mode='']")

        check(not errors, f"no console errors ({errors[:5]})")
        ctx.close()
        browser.close()

    print("\nFAILED: " + "; ".join(failures) if failures else "\nALL PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
