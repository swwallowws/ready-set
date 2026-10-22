// The import window's local server: serves the page and runs actions for the
// right token only, one at a time, and reports a failed action. Plain Node.
//
//   npm test

import assert from "node:assert/strict";
import { startWindowServer } from "../src/windowServer.ts";

let n = 0;
const order: string[] = [];
const server = await startWindowServer(
  () => `<p>page ${n}</p>`,
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
  const url = new URL(server.url);
  assert.equal(url.hostname, "localhost");
  const token = url.searchParams.get("t")!;
  assert.match(token, /^[0-9a-f]{32}$/);
  const at = (path: string, t = token) => `http://127.0.0.1:${url.port}${path}?t=${t}`;
  const post = (body: unknown, t = token) =>
    fetch(at("/act", t), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // The page, for the right token only.
  const page = await fetch(at("/"));
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<p>page 0</p>");
  assert.equal((await fetch(at("/", "wrong"))).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${url.port}/`)).status, 403);

  // Actions answer with the new state, and a wrong token never reaches them.
  assert.deepEqual(await (await post({ action: "search" })).json(), { mode: "search", n: 1 });
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
  assert.match(await bad.text(), /nope/);
  assert.equal((await post({ action: "after" })).status, 200);

  // Not JSON, or an unknown path.
  assert.equal((await fetch(at("/act"), { method: "POST", body: "{" })).status, 400);
  assert.equal((await fetch(at("/other"))).status, 404);

  console.log(`window server ok: port ${url.port}`);
} finally {
  server.close();
}
