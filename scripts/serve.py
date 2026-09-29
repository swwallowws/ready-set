#!/usr/bin/env python3
"""Serve the tabridge web UI and proxy source requests (to dodge browser CORS).
The WASM does all the real work in the browser; this just (a) serves the static
files in web/, (b) forwards allow-listed source URLs (BitMidi, Mutopia,
FreeMIDI search), (c) runs FreeMIDI's two-step cookie download, and (d) answers
/site.json so the page knows the proxy is there (the static build says it isn't).

    scripts/serve.py [port]       # default 8000, then open http://localhost:8000

Build the WASM first: wasm-pack build --target web --out-dir web/pkg
"""
import json
import subprocess
import sys
import tempfile
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
# Only these hosts may be proxied.
ALLOWED = ("bitmidi.com", "freemidi.org", "www.mutopiaproject.org",
           "mutopiaproject.org")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Dev server: never cache, so edits to app.js/index.html show on reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy?"):
            return self.proxy()
        if self.path.startswith("/freemidi?"):
            return self.freemidi()
        if self.path.startswith("/shared/"):
            return self.serve_shared()
        if urllib.parse.urlparse(self.path).path == "/site.json":
            return self.site_json()
        super().do_GET()

    def site_json(self):
        # Tells app.js this host has the proxy (the static build ships a
        # site.json saying it doesn't) and whether a local Live template exists.
        body = json.dumps({"proxy": True,
                           "template": (WEB_DIR / "template.als.xml").is_file()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_shared(self):
        # The design tokens live in ../shared (shared with the Ableton
        # extension) so both surfaces draw from ONE source of truth; expose
        # that dir read-only over HTTP so index.html can <link> it.
        rel = urllib.parse.urlparse(self.path).path[len("/shared/"):]
        base = Path(__file__).resolve().parent.parent / "shared"
        target = (base / rel).resolve()
        if base not in target.parents or not target.is_file():
            self.send_error(404, "not found")
            return
        ctype = {".css": "text/css", ".js": "text/javascript",
                 ".woff2": "font/woff2"}.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        text = ctype.startswith("text/")
        self.send_header("Content-Type", f"{ctype}; charset=utf-8" if text else ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy(self):
        query = urllib.parse.urlparse(self.path).query
        target = urllib.parse.parse_qs(query).get("url", [""])[0]
        host = urllib.parse.urlparse(target).hostname or ""
        if host not in ALLOWED:
            self.send_error(403, f"host not allowed: {host}")
            return
        try:
            # curl handles gzip (--compressed) and HTTP 103 Early Hints, which
            # urllib chokes on.
            body = subprocess.run(
                ["curl", "-sS", "-f", "--compressed", "-m", "30", "-A", UA, target],
                check=True, capture_output=True,
            ).stdout
        except subprocess.CalledProcessError as e:
            self.send_error(502, f"upstream fetch failed: {e}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def freemidi(self):
        # FreeMIDI gates its downloads: a bare GET of getter-<id> 500s. You must
        # first hit download3-<id> (which sets a session cookie), then fetch
        # getter-<id> carrying that cookie + referer. We do both server-side
        # with a throwaway cookie jar and return the raw .mid.
        query = urllib.parse.urlparse(self.path).query
        fid = urllib.parse.parse_qs(query).get("id", [""])[0]
        if not fid.isdigit():
            self.send_error(400, "bad freemidi id")
            return
        step1 = f"https://freemidi.org/download3-{fid}"
        getter = f"https://freemidi.org/getter-{fid}"
        try:
            with tempfile.NamedTemporaryFile() as jar:
                subprocess.run(
                    ["curl", "-sS", "-f", "--compressed", "-m", "30", "-A", UA,
                     "-c", jar.name, "-o", "/dev/null", step1],
                    check=True, capture_output=True,
                )
                body = subprocess.run(
                    ["curl", "-sS", "-f", "-L", "--compressed", "-m", "30", "-A", UA,
                     "-b", jar.name, "-e", step1, getter],
                    check=True, capture_output=True,
                ).stdout
        except subprocess.CalledProcessError as e:
            self.send_error(502, f"freemidi fetch failed: {e}")
            return
        if body[:4] != b"MThd":
            self.send_error(502, "freemidi did not return MIDI")
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/midi")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    if not (WEB_DIR / "pkg" / "tabridge.js").exists():
        print("⚠️  web/pkg not found; run:  wasm-pack build --target web --out-dir web/pkg")
    handler = partial(Handler, directory=str(WEB_DIR))
    print(f"Ready Set web UI → http://localhost:{port}  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    main()
