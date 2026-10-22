// The import window's local server: serves the page and runs actions for the
// right token only, one at a time, reports a failed action, and survives a
// throw while answering. Runs with no global URL, as in Ableton Live's
// extension host (a bare `new URL` there ended the host). Plain Node.
//
//   npm test

import assert from "node:assert/strict";
import * as http from "node:http";
import { URL as NodeURL } from "node:url";

delete (globalThis as any).URL;   // as in Live's extension host
const { startWindowServer } = await import("../src/windowServer.ts");

// A small client on node:http, so the test needs no globals either.
function req(method: string, url: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

let n = 0;
let pageThrows = false;
const order: string[] = [];
const server = await startWindowServer(
  () => { if (pageThrows) throw new Error("page broke"); return `<p>page ${n}</p>`; },
  async (p: any) => {
    if (p.action === "fail") throw new Error("nope");
    order.push(`start ${p.action}`);
    await new Promise((r) => setTimeout(r, p.action === "slow" ? 60 : 1));
    order.push(`end ${p.action}`);
    return { mode: p.action, n: ++n };
  },
);
assert.ok(server, "the server starts");
try {
  const url = new NodeURL(server.url);
  assert.equal(url.hostname, "localhost");
  const token = url.searchParams.get("t")!;
  assert.match(token, /^[0-9a-f]{32}$/);
  const at = (path: string, t = token) => `http://127.0.0.1:${url.port}${path}?t=${t}`;
  const post = (body: unknown, t = token) => req("POST", at("/act", t), JSON.stringify(body));

  // The page, for the right token only.
  const page = await req("GET", at("/"));
  assert.equal(page.status, 200);
  assert.equal(page.text, "<p>page 0</p>");
  assert.equal((await req("GET", at("/", "wrong"))).status, 403);
  assert.equal((await req("GET", `http://127.0.0.1:${url.port}/`)).status, 403);

  // Actions answer with the new state, and a wrong token never reaches them.
  assert.deepEqual(JSON.parse((await post({ action: "search" })).text), { mode: "search", n: 1 });
  assert.equal((await post({ action: "search" }, "wrong")).status, 403);
  assert.equal(n, 1);

  // One at a time, in arrival order, even when the first is slower.
  order.length = 0;
  const [a, b] = await Promise.all([post({ action: "slow" }), post({ action: "quick" })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(order, ["start slow", "end slow", "start quick", "end quick"]);

  // A failed action is a 500 with its message; the next one still runs.
  const bad = await post({ action: "fail" });
  assert.equal(bad.status, 500);
  assert.match(bad.text, /nope/);
  assert.equal((await post({ action: "after" })).status, 200);

  // A throw while answering is a 500 too, and the server keeps going.
  pageThrows = true;
  const broken = await req("GET", at("/"));
  assert.equal(broken.status, 500);
  assert.match(broken.text, /page broke/);
  pageThrows = false;
  assert.equal((await req("GET", at("/"))).status, 200);

  // Not JSON, or an unknown path.
  assert.equal((await req("POST", at("/act"), "{")).status, 400);
  assert.equal((await req("GET", at("/other"))).status, 404);

  console.log(`window server ok: port ${url.port}, no global URL`);
} finally {
  server.close();
}
