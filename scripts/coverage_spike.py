"""Source-coverage spike: how much of a real song list do scoreseek's licensed sources cover?

Searches every scoreseek source for a list of real songs and records what
comes back (source, license, formats). Output goes to spike/coverage.json.

Run: .venv/bin/python scripts/coverage_spike.py
"""

import json
import sys
from pathlib import Path

import scoreseek
import scoreseek.sources as S

ROOT = Path(__file__).resolve().parent.parent
PDMX_DIR = ROOT / "spike" / "pdmx"
OUT = ROOT / "spike" / "coverage.json"

SONGS = [
    ("Duman", "Elleri Ellerime"),
    ("Aleyna Tilki", "Bitti"),
    ("Nova Norda", "Aikido Tekvando"),
    ("Deftones", "fyihyd"),
    ("Thom Yorke", "Analyse"),
    ("Hepsi", "Aşk Sakızı"),
    ("Hande Yener", "Sen Yoluna Ben Yoluma"),
    ("Aphex Twin", "Ageispolis"),
]


def register_optional_sources():
    """Opt in to every source that doesn't need credentials."""
    names = [n for n in dir(S) if n.endswith("Source")]
    print("available source classes:", names)
    for name in names:
        # Chordonomicon times out and Kaggle needs credentials; both are
        # chord-only, so they can't replace per-instrument note tracks anyway.
        if name in ("Source", "LocalFolderSource", "ChordonomiconSource", "KaggleChordsSource"):
            continue
        cls = getattr(S, name)
        try:
            if name == "PDMXSource":
                src = cls(str(PDMX_DIR))
            else:
                src = cls()
            scoreseek.register_source(src)
            print("registered", name)
        except Exception as e:  # noqa: BLE001 - spike: report and move on
            print(f"skipped {name}: {e!r}")


def describe(hit):
    d = {k: v for k, v in vars(hit).items() if not k.startswith("_")}
    return {k: (v if isinstance(v, (str, int, float, bool, type(None), list, tuple)) else str(v)) for k, v in d.items()}


def main():
    register_optional_sources()
    results = []
    for artist, title in SONGS:
        entry = {"artist": artist, "title": title, "queries": {}}
        for query in (title, f"{artist} {title}"):
            try:
                hits = scoreseek.search(query, allow_copyrighted=True)
                entry["queries"][query] = [describe(h) for h in hits[:15]]
            except Exception as e:  # noqa: BLE001
                entry["queries"][query] = f"error: {e!r}"
        results.append(entry)
        n = {q: (len(v) if isinstance(v, list) else v) for q, v in entry["queries"].items()}
        print(f"{artist} - {title}: {n}")
    OUT.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str))
    print("wrote", OUT)


if __name__ == "__main__":
    sys.exit(main())
