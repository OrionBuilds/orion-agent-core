import { test } from "node:test";
import assert from "node:assert/strict";
import { braveSearch } from "./brave";
import { fixture, fakeFetch, type Seen } from "./testUtil";

test("brave: parses results, drops rows missing title/url, sends the subscription token header", async () => {
  const seen: Seen[] = [];
  const r = await braveSearch.call({ query: "roofing contractor Springfield", count: 25, offset: 2, freshness: "pm" }, { key: "tok", fetchImpl: fakeFetch([{ status: 200, body: fixture("brave", "web.json") }], seen) });
  assert.ok(r.ok);
  assert.equal(r.costUnits, 1);
  assert.equal(r.data.results.length, 2);
  assert.deepEqual(r.data.results[0], { title: "Acme Co – Springfield Roofing", url: "https://acmeco.example.com/", snippet: "Springfield's roofing contractor since 2008.", age: "2 weeks ago" });
  const u = new URL(seen[0].url);
  assert.equal(u.searchParams.get("q"), "roofing contractor Springfield");
  assert.equal(u.searchParams.get("count"), "20"); // capped
  assert.equal(u.searchParams.get("offset"), "2");
  assert.equal(u.searchParams.get("freshness"), "pm");
  assert.equal(seen[0].headers["x-subscription-token"], "tok");
});

test("brave: empty query and missing key are refused without a request; 429 is rateLimited", async () => {
  const seen: Seen[] = [];
  assert.ok(!(await braveSearch.call({ query: "  " }, { key: "tok", fetchImpl: fakeFetch([], seen) })).ok);
  assert.ok(!(await braveSearch.call({ query: "x" }, { key: "", fetchImpl: fakeFetch([], seen) })).ok);
  assert.equal(seen.length, 0);
  const r = await braveSearch.call({ query: "x" }, { key: "tok", fetchImpl: fakeFetch([{ status: 429, body: '{"message":"rate limited"}' }]) });
  assert.ok(!r.ok && r.rateLimited === true && r.status === 429);
});
