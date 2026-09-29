"""Cross-check for the coverage spike: how often do these artists appear in PDMX?

Reads the PDMX index (spike/pdmx/PDMX.csv) and prints, per artist, the rows
whose title/artist/composer text mentions them, with license and track count.

Run: .venv/bin/python scripts/pdmx_artist_check.py
"""

from pathlib import Path

import pandas as pd

CSV = Path(__file__).resolve().parent.parent / "spike" / "pdmx" / "PDMX.csv"

ARTISTS = ["duman", "aleyna tilki", "nova norda", "deftones", "thom yorke",
           "radiohead", "hepsi", "hande yener", "aphex twin", "ageispolis",
           "elleri ellerime", "fyihyd"]


def main():
    df = pd.read_csv(CSV, low_memory=False)
    print("rows:", len(df))
    print("columns:", list(df.columns))
    text_cols = ["song_name", "title", "subtitle", "artist_name", "composer_name", "tags"]
    print("searching columns:", text_cols)
    blob = df[text_cols].fillna("").astype(str).agg(" | ".join, axis=1).str.lower()
    show = ["title", "artist_name", "composer_name", "license", "license_conflict", "n_tracks", "tracks"]
    for a in ARTISTS:
        hits = df[blob.str.contains(a, regex=False)]
        print(f"\n== {a}: {len(hits)} rows")
        if len(hits):
            print(hits[show].head(10).to_string(max_colwidth=50))


if __name__ == "__main__":
    main()
