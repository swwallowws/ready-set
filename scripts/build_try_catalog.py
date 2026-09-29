#!/usr/bin/env python3
"""Freeze a small public-domain catalogue for the guided /try/ page.

    tabridge/.venv/bin/python tabridge/scripts/build_try_catalog.py

Searches the Mutopia Project for a fixed list of queries, keeps only pieces
whose licence is Public Domain, CC BY or CC BY-SA, downloads each .mid into
web/try/catalog/ and writes web/try/catalog/catalog.json:

    [{ uid, title, artist, licence, credit, file }]

Stdlib only. Polite: one request at a time, 0.5 s apart.
"""
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "try" / "catalog"
MUTOPIA = "https://www.mutopiaproject.org"
QUERIES = ["greensleeves", "bach", "satie", "chopin", "mozart", "beethoven",
           "scarborough", "carol", "waltz", "minuet", "joplin", "canon"]
CAP_TOTAL = 60
CAP_PER_QUERY = CAP_TOTAL // len(QUERIES)  # spread the catalogue over every query
MAX_MIDI_BYTES = 200_000                   # keep the page light
PAUSE = 0.5
UA = "tabridge-try-catalog/1.0 (+https://github.com/swwallowws/ready-set)"

_last = 0.0


def fetch(url: str) -> bytes:
    """GET one URL, at most one request every PAUSE seconds."""
    global _last
    wait = _last + PAUSE - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.read()
    finally:
        _last = time.monotonic()


def strip_tags(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]*>", "", s)).replace("\xa0", " ").strip()


def search_url(q: str) -> str:
    # Same URL as mutopiaSearchUrl() in shared/sources.js.
    return f"{MUTOPIA}/cgibin/make-table.cgi?searchingfor={urllib.parse.quote(q)}"


def norm_mutopia(page: str):
    """Python port of normMutopia() in shared/sources.js (same regexes): one
    result-table block per piece, rows without a direct .mid link skipped.
    One addition: when there is no "by <composer>" cell, the composer comes
    from the second cell (the search page lists it bare, e.g. "Traditional")."""
    blocks = re.split(r"<table[^>]*result-table[^>]*>", page, flags=re.I)[1:]
    out = []
    for b in blocks:
        mid = re.search(r'href="(https?://[^"]+\.mid)"', b, re.I)
        if not mid:
            continue
        pid = re.search(r"piece-info\.cgi\?id=(\d+)", b, re.I)
        if not pid:
            continue
        tds = [strip_tags(x) for x in re.findall(r"<td[^>]*>([\s\S]*?)</td>", b, re.I)]
        title = (tds[0] if tds else "").strip() or "Untitled"
        by = next((t for t in tds if re.match(r"^by\s+", t, re.I)), "")
        composer = by or (tds[1] if len(tds) > 1 else "")
        artist = re.sub(r"\s*\([^)]*\)\s*$", "", re.sub(r"^by\s+", "", composer, flags=re.I)).strip()
        out.append({"id": pid.group(1), "title": title, "artist": artist, "mid": mid.group(1)})
    return out


# Strict licence filter: Public Domain, CC BY, CC BY-SA. Anything else
# (NonCommercial, NoDerivs, unknown) is dropped.
LICENCES = [
    (re.compile(r"^Public Domain$", re.I), lambda m: "Public Domain"),
    (re.compile(r"^Creative Commons Attribution ([\d.]+)", re.I), lambda m: f"CC BY {m.group(1)}"),
    (re.compile(r"^Creative Commons Attribution-ShareAlike ([\d.]+)", re.I), lambda m: f"CC BY-SA {m.group(1)}"),
]


def piece_info(pid: str):
    """(licence short name or None, maintainer) from a piece-info page."""
    page = fetch(f"{MUTOPIA}/cgibin/piece-info.cgi?id={pid}").decode("utf-8", "replace")
    cm = re.search(r"<b>Copyright:</b>\s*(?:<a[^>]*>)?([^<]+)", page, re.I)
    raw = strip_tags(cm.group(1)) if cm else ""
    licence = None
    for rx, short in LICENCES:
        m = rx.match(raw)
        if m:
            licence = short(m)
            break
    mm = re.search(r"<b>Maintainer:</b>\s*([^<]+)", page, re.I)
    maintainer = strip_tags(mm.group(1)) if mm else "a volunteer"
    return licence, raw, maintainer


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    rows, seen = [], set()
    for q in QUERIES:
        if len(rows) >= CAP_TOTAL:
            break
        try:
            found = norm_mutopia(fetch(search_url(q)).decode("utf-8", "replace"))
        except Exception as e:  # one bad query shouldn't sink the catalogue
            print(f"[{q}] search failed: {e}")
            continue
        kept = 0
        for p in found:
            if kept >= CAP_PER_QUERY or len(rows) >= CAP_TOTAL:
                break
            if p["id"] in seen:
                continue
            seen.add(p["id"])
            try:
                licence, raw, maintainer = piece_info(p["id"])
            except Exception as e:
                print(f"[{q}] {p['id']}: piece-info failed: {e}")
                continue
            if not licence:
                print(f"[{q}] skip {p['id']} {p['title']!r}: licence {raw!r}")
                continue
            try:
                data = fetch(p["mid"])
            except Exception as e:
                print(f"[{q}] {p['id']}: midi failed: {e}")
                continue
            if data[:4] != b"MThd" or len(data) > MAX_MIDI_BYTES:
                print(f"[{q}] skip {p['id']}: not MIDI or too large ({len(data)} bytes)")
                continue
            name = f"mutopia-{p['id']}.mid"
            (OUT / name).write_bytes(data)
            artist = p["artist"] or "Anonymous"
            rows.append({
                "uid": f"mutopia_{p['id']}",
                "title": p["title"],
                "artist": artist,
                "licence": licence,
                "credit": f"{p['title']} by {artist}, typeset by {maintainer} for the Mutopia Project, {licence}",
                "file": f"catalog/{name}",
            })
            kept += 1
            print(f"[{q}] + {p['title']} ({artist}, {licence})")
    (OUT / "catalog.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(rows)} pieces -> {OUT / 'catalog.json'}")
    return 0 if rows else 1


if __name__ == "__main__":
    sys.exit(main())
