"""Render the Ableton extension's modal outside Live, for a visual check.

Injects the design tokens (fonts inlined), the value box, roll.js and a sample state into
extension/src/interface.html the same way extension/build.ts and
extension.ts do, then screenshots the start / results / preview screens in
both colour schemes into spike/shots/.

Run: .venv/bin/python scripts/modal_preview.py
"""

import base64
import json
import math
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DESIGN = ROOT / "shared" / "vendor" / "design"
SHOTS = ROOT / "spike" / "shots"


def modal_html(state):
    html = (ROOT / "extension" / "src" / "interface.html").read_text()
    tokens = (DESIGN / "tokens.css").read_text()
    tokens = re.sub(r'url\("fonts/([^"]+\.woff2)"\)',
                    lambda m: 'url("data:font/woff2;base64,'
                    + base64.b64encode((DESIGN / "fonts" / m.group(1)).read_bytes()).decode() + '")', tokens)
    roll = (ROOT / "shared" / "roll.js").read_text()
    vb_css = (DESIGN / "valuebox.css").read_text()
    vb_js = re.sub(r"^export ", "", (DESIGN / "valuebox.js").read_text(), flags=re.M)
    valuebox = "(function(){\n" + vb_js + "\nwindow.DesignValueBox = { valueBox };\n})();"
    html = (html.replace("/*__TOKENS__*/", tokens).replace("/*__VALUEBOX_CSS__*/", vb_css)
            .replace("/*__ROLL__*/", roll).replace("/*__VALUEBOX__*/", valuebox))
    return html.replace("'__STATE__'", json.dumps(state))


def sample_preview(beats=64, label="Sample · Song"):
    p, s, d, k, v = [], [], [], [], []
    for i in range(beats * 2):   # a bassline and a melody
        b = i / 2
        p.append(40 + [0, 7, 5, 3][(i // 4) % 4]); s.append(b); d.append(0.45); k.append(0); v.append(0.5 + 0.5 * (i % 4 == 0))
        p.append(64 + round(5 * math.sin(i / 3))); s.append(b); d.append(0.4); k.append(0); v.append(0.4 + 0.6 * ((i * 7) % 5) / 4)
        p.append(36 if i % 4 == 0 else 42); s.append(b); d.append(0.1); k.append(1); v.append(0.8)
    order = sorted(range(len(p)), key=lambda j: s[j])
    pick = lambda a: [a[j] for j in order]
    return {"label": label, "tempo": 120, "beats": beats, "truncated": False,
            "p": pick(p), "s": pick(s), "d": pick(d), "k": pick(k), "v": pick(v)}


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    intro = {**sample_preview(32, "Bach · Prelude"), "uid": "mutopia_1"}
    results = [
        {"uid": "mutopia_1", "id": 1, "artist": "J. S. Bach", "title": "Prelude in C", "tracks": None, "source": "mutopia", "intro": intro},
        {"uid": "freemidi_2", "id": 2, "artist": "Duman", "title": "Elleri Ellerime", "tracks": None, "source": "freemidi"},
        {"uid": "midi_3", "id": 3, "artist": "Metallica", "title": "Nothing Else Matters", "tracks": 9, "source": "midi"},
    ]
    states = {
        "start": {"mode": "start", "results": [], "query": "", "uploads": False, "semitones": 0, "error": "", "selectedUid": None},
        "start-error": {"mode": "start", "results": [], "query": "", "uploads": False, "semitones": 0,
                        "error": "Couldn't read notes.txt: parse failed: not MusicXML", "selectedUid": None},
        "results": {"mode": "results", "results": results, "query": "bach", "uploads": True, "semitones": 2,
                    "error": "", "selectedUid": "mutopia_1", "intro": None},
        "preview": {"mode": "preview", "results": [], "query": "", "uploads": False, "semitones": 2, "error": "",
                    "selectedUid": "file_0", "previewFrom": "start", "preview": sample_preview()},
    }
    errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        for scheme in ("light", "dark"):
            ctx = b.new_context(color_scheme=scheme, viewport={"width": 460, "height": 620})
            for name, st in states.items():
                page = ctx.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.set_content(modal_html(st))
                page.wait_for_timeout(300)
                if name == "results":   # open the inline intro roll
                    page.click(".res-play[data-inline]")
                    page.wait_for_timeout(400)
                page.screenshot(path=str(SHOTS / f"modal-{name}-{scheme}.png"))
                page.close()
            ctx.close()
        b.close()
    print("page errors:", errors or "none")


if __name__ == "__main__":
    main()
