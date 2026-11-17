// Tests for the cross-session recall store — the properties that make recall trustworthy: the
// schema opens (WAL or fallback), what gets recorded is findable with its session context, FTS
// ranking surfaces the RIGHT session, JSONL backfill can be re-run forever without duplicating
// history, and losing FTS5 degrades search instead of breaking writes.
//
// Run: npm test (inside AGENTOS-CORE)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { openSessionStore, daySessionId, formatRecallMatches } from "./index";

async function tmpStore(opts?: { fts?: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recall-"));
  const store = await openSessionStore(path.join(root, "recall.db"), opts);
  return { store, root };
}

test("schema creates, journal mode settles, and a reopen finds the same data", async () => {
  const { store, root } = await tmpStore();
  assert.ok(["wal", "delete", "truncate", "persist", "memory"].includes(store.journalMode));
  store.record({ agent: "clara", role: "user", content: "remember the boat insurance renewal", at: "2026-08-01T10:00:00Z" });
  store.close();
  const again = await openSessionStore(path.join(root, "recall.db"));
  assert.equal(again.search({ query: "boat insurance" }).length, 1);
  again.close();
});

test("record + search roundtrip returns session context and a snippet", async () => {
  const { store } = await tmpStore();
  store.record({ agent: "clara", role: "user", content: "Can you plan the Denver trip for October?", at: "2026-08-02T09:00:00Z" });
  store.record({ agent: "clara", role: "clara", content: "Denver trip planned: flights Friday, hotel downtown.", at: "2026-08-02T09:01:00Z" });
  const hits = store.search({ query: "denver trip" });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].sessionId, daySessionId("clara", "chat", "2026-08-02T09:00:00Z"));
  // First user message titled the session; every hit carries it plus a non-empty snippet.
  assert.equal(hits[0].title, "Can you plan the Denver trip for October?");
  assert.ok(hits[0].snippet.toLowerCase().includes("denver"));
  assert.ok(formatRecallMatches(hits).startsWith("[2026-08-02 · Can you plan the Denver trip"));
});

test("FTS ranking surfaces the session that is actually about the query", async () => {
  const { store } = await tmpStore();
  // One passing mention vs. a session that is ABOUT zernio invoices — rank must prefer the latter.
  store.record({ agent: "clara", role: "user", content: "unrelated day, someone mentioned zernio once", at: "2026-07-01T10:00:00Z" });
  for (const [i, text] of [
    "the zernio invoice dispute needs the March invoice numbers",
    "zernio invoice totals reconciled, invoice PDF filed",
  ].entries()) {
    store.record({ agent: "clara", role: "user", content: text, at: `2026-07-15T10:0${i}:00Z` });
  }
  const hits = store.search({ query: "zernio invoice" });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].sessionId, daySessionId("clara", "chat", "2026-07-15"));
});

test("agent filter keeps one agent's recall out of another's", async () => {
  const { store } = await tmpStore();
  store.record({ agent: "clara", role: "user", content: "budget review for the front office", at: "2026-08-03T10:00:00Z" });
  store.record({ agent: "friday", role: "user", content: "budget review for the deploy pipeline", at: "2026-08-03T11:00:00Z" });
  assert.equal(store.search({ query: "budget review", agent: "clara" }).length, 1);
  assert.equal(store.search({ query: "budget review" }).length, 2);
});

test("hostile query strings never throw (FTS syntax is neutralized)", async () => {
  const { store } = await tmpStore();
  store.record({ agent: "clara", role: "user", content: "NEAR the office AND the depot", at: "2026-08-03T10:00:00Z" });
  for (const q of ['"unbalanced', "col: value*", "a AND OR NOT (", "   "]) {
    assert.doesNotThrow(() => store.search({ query: q }));
  }
  assert.ok(store.search({ query: "NEAR office" }).length >= 1);
});

test("indexJsonl backfills once, then re-runs and appends idempotently", async () => {
  const { store, root } = await tmpStore();
  const file = path.join(root, "messages.jsonl");
  const rows = [
    { id: "1", ts: "2026-06-01T09:00:00Z", role: "user", text: "book the piano tuner" },
    { id: "2", ts: "2026-06-01T09:01:00Z", role: "clara", text: "Piano tuner booked for Thursday." },
  ];
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const first = await store.indexJsonl(file, { agent: "clara" });
  assert.equal(first.ingested, 2);
  // Re-run: the byte offset skips everything — no dupes, no re-parse.
  const second = await store.indexJsonl(file, { agent: "clara" });
  assert.equal(second.ingested, 0);
  assert.equal(second.skipped, 0);
  // Append one line; only it gets ingested.
  await fs.appendFile(file, JSON.stringify({ id: "3", ts: "2026-06-01T09:05:00Z", role: "user", text: "also the piano bench" }) + "\n", "utf8");
  const third = await store.indexJsonl(file, { agent: "clara" });
  assert.equal(third.ingested, 1);
  assert.equal(store.recentSessions({ agent: "clara" })[0].messageCount, 3);
});

test("backfill and live recording of the same row collapse to one message", async () => {
  const { store, root } = await tmpStore();
  const row = { id: "1", ts: "2026-06-02T09:00:00Z", role: "user", text: "renew the passports" };
  // Live path saw it first (same fields the JSONL row carries)…
  store.record({ agent: "clara", role: row.role, content: row.text, at: row.ts });
  // …then a backfill replays the file it was also written to.
  const file = path.join(root, "messages.jsonl");
  await fs.writeFile(file, JSON.stringify(row) + "\n", "utf8");
  const res = await store.indexJsonl(file, { agent: "clara" });
  assert.equal(res.ingested, 0);
  assert.equal(res.skipped, 1);
  assert.equal(store.recentSessions()[0].messageCount, 1);
});

test("a partial (unterminated) last line is left for the next run, not half-parsed", async () => {
  const { store, root } = await tmpStore();
  const file = path.join(root, "messages.jsonl");
  const full = JSON.stringify({ ts: "2026-06-03T09:00:00Z", role: "user", text: "full line" });
  await fs.writeFile(file, full + "\n" + '{"ts":"2026-06-03T09:01:00Z","role":"user","te', "utf8");
  assert.equal((await store.indexJsonl(file, { agent: "clara" })).ingested, 1);
  // Writer finishes the line; the re-run picks up exactly it.
  await fs.appendFile(file, 'xt":"finished line"}\n', "utf8");
  assert.equal((await store.indexJsonl(file, { agent: "clara" })).ingested, 1);
});

test("without FTS5, writes still land and search degrades to LIKE with the same shape", async () => {
  const { store } = await tmpStore({ fts: false });
  assert.equal(store.ftsEnabled, false);
  store.record({ agent: "clara", role: "user", content: "the generator needs a 50% oil_change soon", at: "2026-08-04T10:00:00Z" });
  const hits = store.search({ query: "generator oil_change" });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].snippet.includes("generator"));
  // LIKE wildcards in the query match literally, not as wildcards.
  assert.equal(store.search({ query: "gen%rator" }).length, 0);
});

test("recentSessions lists newest-last-activity first with counts", async () => {
  const { store } = await tmpStore();
  store.record({ agent: "clara", role: "user", content: "old thing", at: "2026-05-01T10:00:00Z" });
  store.record({ agent: "clara", role: "user", content: "new thing", at: "2026-08-05T10:00:00Z" });
  store.record({ agent: "clara", role: "clara", content: "new thing done", at: "2026-08-05T10:01:00Z" });
  const rows = store.recentSessions({ agent: "clara" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, daySessionId("clara", "chat", "2026-08-05"));
  assert.equal(rows[0].messageCount, 2);
});
