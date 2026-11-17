import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { postEscalation, postStatus } from "./escalate";
import type { EscalationRequest, StatusRequest } from "./index";

const esc: EscalationRequest = {
  from: "friday", kind: "escalate", category: "production", headline: "Acme Co is down", detail: "3 probes failed",
  links: [], dedupeKey: "friday:uptime.down:p1:2026-09-24", occurredAt: "2026-09-24T12:00:00Z", source: { app: "friday", kind: "uptime.down", refId: "p1" },
};
const status: StatusRequest = { from: "clara", kind: "status", subject: { type: "project", name: "roof" } };

function serve(handler: (path: string, body: string) => { code: number; json?: unknown; delayMs?: number }) {
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const r = handler(req.url ?? "", raw);
      setTimeout(() => { res.writeHead(r.code, { "content-type": "application/json" }); res.end(r.json === undefined ? "" : JSON.stringify(r.json)); }, r.delayMs ?? 0);
    });
  });
  return new Promise<{ base: string; close: () => void }>((resolve) => srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address() as { port: number };
    resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => srv.close() });
  }));
}

test("postEscalation posts to /api/agent/escalate with the secret header and returns the response", async () => {
  process.env.INTERAGENT_SHARED_SECRET = "s3cret";
  let seenPath = "", seenBody = "";
  const s = await serve((path, body) => { seenPath = path; seenBody = body; return { code: 200, json: { ok: true, id: "e1", action: "called", via: "clara" } }; });
  try {
    const r = await postEscalation(s.base + "/", esc);
    assert.equal(seenPath, "/api/agent/escalate");
    assert.equal(JSON.parse(seenBody).dedupeKey, esc.dedupeKey);
    assert.deepEqual(r, { ok: true, id: "e1", action: "called", via: "clara", error: undefined });
  } finally { s.close(); delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("postEscalation never throws: HTTP errors and timeouts become ok:false", async () => {
  const s = await serve((path) => (path.includes("slow") ? { code: 200, json: { ok: true }, delayMs: 300 } : { code: 500, json: { error: "boom" } }));
  try {
    const bad = await postEscalation(s.base, esc);
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /HTTP 500/);
    const slow = await postEscalation(s.base, esc, { path: "/slow", timeoutMs: 50 });
    assert.equal(slow.ok, false);
    assert.match(slow.error ?? "", /timeout/);
  } finally { s.close(); }
  const dead = await postEscalation("http://127.0.0.1:1", esc, { timeoutMs: 500 });
  assert.equal(dead.ok, false);
});

test("postStatus uses an explicit path and rejects malformed bodies", async () => {
  const s = await serve((path) => path === "/api/friday/status"
    ? { code: 200, json: { ok: false, error: "ambiguous", candidates: [{ id: "1", name: "Acme Co" }] } }
    : { code: 200, json: { nope: true } });
  try {
    const r = await postStatus(s.base, status, { path: "/api/friday/status" });
    assert.equal(r.ok, false);
    assert.deepEqual((r as { candidates?: unknown }).candidates, [{ id: "1", name: "Acme Co" }]);
    const m = await postStatus(s.base, status);
    assert.deepEqual(m, { ok: false, error: "malformed status response" });
  } finally { s.close(); }
});

test("postEscalation treats a 2xx with an empty or shapeless body as NOT a receipt", async () => {
  const s = await serve((path) => (path.includes("empty") ? { code: 200, json: "" } : { code: 200, json: { id: "x" } }));
  try {
    const empty = await postEscalation(s.base, esc, { path: "/empty" });
    assert.equal(empty.ok, false);
    assert.match(empty.error ?? "", /malformed/);
    const shapeless = await postEscalation(s.base, esc, { path: "/shapeless" });
    assert.equal(shapeless.ok, false);
  } finally { s.close(); }
});

test("postStatus requires the full success shape, keeps well-formed ok:false results", async () => {
  const full = {
    ok: true, asOf: "2026-09-24T12:00:00Z", agent: "friday",
    subject: { type: "project", id: "1", name: "Acme Co" },
    summary: { status: "active", health: "green", headline: "On track." },
    recent: [], open: [], blocked: [], nextUp: [], approvalsPending: [], sources: [],
  };
  const s = await serve((path) => path === "/full" ? { code: 200, json: full } : path === "/bare" ? { code: 200, json: { ok: true } } : { code: 200, json: { ok: false } });
  try {
    const good = await postStatus(s.base, status, { path: "/full" });
    assert.equal(good.ok, true);
    const bare = await postStatus(s.base, status, { path: "/bare" });
    assert.deepEqual(bare, { ok: false, error: "malformed status response" });
    const noError = await postStatus(s.base, status, { path: "/noerr" });
    assert.deepEqual(noError, { ok: false, error: "malformed status response" });
  } finally { s.close(); }
});

test("client.status capability prompts as a client lookup regardless of args.type", async () => {
  const { statusCapabilities } = await import("./escalate.ts");
  const caps = statusCapabilities();
  assert.equal(caps["client.status"].toPrompt({ name: "Acme" }), "Status of client Acme");
  assert.equal(caps["project.status"].toPrompt({ name: "Acme Co" }), "Status of project Acme Co");
});
