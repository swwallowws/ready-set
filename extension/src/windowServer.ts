// Serves the import window from http://localhost, so the window can ask the
// host to search, load and preview while it stays open. (A modal dialog only
// hands back one result and closes, so a data: URL window has to close and
// reopen for every step that needs the host.)
//
// Loopback only, and every request must carry the random token from the
// window's URL, so other apps and web pages on the machine can't drive it.
// Actions run one at a time, in the order they arrive.
//
// This file has no SDK or WASM imports, so it runs under plain Node for tests.

import * as http from "node:http";
import { randomBytes } from "node:crypto";

export type WindowServer = { url: string; close(): void };
type Log = (...a: unknown[]) => void;

/** Start the window's server: GET / is the page, POST /act runs one action and
 *  answers with the new state as JSON. Resolves null if it can't listen (the
 *  caller then falls back to a window that reopens for each step). */
export async function startWindowServer(
  page: () => string,
  act: (payload: any) => Promise<unknown>,
  log: Log = () => {},
): Promise<WindowServer | null> {
  const token = randomBytes(16).toString("hex");
  let queue: Promise<unknown> = Promise.resolve();

  const handler: http.RequestListener = (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.searchParams.get("t") !== token) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page());
      return;
    }
    if (req.method === "POST" && u.pathname === "/act") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let payload: any;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { res.writeHead(400).end("not JSON"); return; }
        const run = queue.then(() => act(payload));
        queue = run.catch(() => {});
        run.then(
          (state) => res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
            .end(JSON.stringify(state)),
          (e) => res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(e)),
        );
      });
      return;
    }
    res.writeHead(404).end();
  };

  const listen = (host: string, port: number) => new Promise<http.Server | null>((resolve) => {
    const s = http.createServer(handler);
    s.once("error", (e) => { log("window server:", host, String(e)); resolve(null); });
    s.listen(port, host, () => resolve(s));
  });

  // "localhost" can resolve to either loopback address, so answer on both;
  // IPv6 is a bonus, IPv4 is required.
  const v4 = await listen("127.0.0.1", 0);
  if (!v4) return null;
  const port = (v4.address() as { port: number }).port;
  const v6 = await listen("::1", port);
  return {
    url: `http://localhost:${port}/?t=${token}`,
    close() { v4.close(); v6?.close(); },
  };
}
