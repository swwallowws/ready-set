"""Print a compact view of spike/coverage.json: one line per hit.

Run: .venv/bin/python scripts/coverage_summary.py
"""

import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "spike" / "coverage.json"

KEYS = ("source", "title", "composer", "artist", "license", "formats")

for entry in json.loads(DATA.read_text()):
    print(f"\n### {entry['artist']} - {entry['title']}")
    for query, hits in entry["queries"].items():
        if not isinstance(hits, list):
            print(f"  [{query}] {hits}")
            continue
        for h in hits:
            parts = [f"{k}={h[k]}" for k in KEYS if h.get(k) not in (None, "", [], ())]
            print(f"  [{query}] " + " | ".join(parts))
