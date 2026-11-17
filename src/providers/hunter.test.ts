import { test } from "node:test";
import assert from "node:assert/strict";
import { hunterDomainSearch, hunterEmailFinder, hunterEmailVerifier, hunterVerdict, domainFrom } from "./hunter";
import { fixture, fakeFetch, type Seen } from "./testUtil";

test("domainFrom normalizes URLs and rejects junk", () => {
  assert.equal(domainFrom("https://www.AcmeCo.Example.com/about?x=1"), "acmeco.example.com");
  assert.equal(domainFrom("acmeco.example.com"), "acmeco.example.com");
  assert.equal(domainFrom("not a domain"), "");
  assert.equal(domainFrom(""), "");
});

test("hunterVerdict maps result/status onto the shared vocabulary", () => {
  assert.equal(hunterVerdict("deliverable", "valid"), "deliverable");
  assert.equal(hunterVerdict("risky", "accept_all"), "catch_all");
  assert.equal(hunterVerdict("undeliverable", "invalid"), "undeliverable");
  assert.equal(hunterVerdict(undefined, undefined), "unknown");
});

test("domain-search: people with sources, key in header not URL, cost 1", async () => {
  const seen: Seen[] = [];
  const r = await hunterDomainSearch.call({ domain: "https://acmeco.example.com/", limit: 500 }, { key: "hk", fetchImpl: fakeFetch([{ status: 200, body: fixture("hunter", "domain-search.json") }], seen) });
  assert.ok(r.ok);
  assert.equal(r.costUnits, 1);
  assert.equal(r.data.organization, "Acme Co");
  assert.equal(r.data.pattern, "{first}");
  assert.equal(r.data.total, 2);
  assert.equal(r.data.people.length, 2);
  assert.deepEqual(r.data.people[0], {
    email: "john@acmeco.example.com", firstName: "John", lastName: "Smith", position: "Owner", seniority: "executive", department: "executive",
    linkedin: "https://www.linkedin.com/in/johnsmithacme", phone: undefined, confidence: 94, type: "personal",
    sources: [{ uri: "https://acmeco.example.com/about", extractedOn: "2026-08-01" }],
  });
  const u = new URL(seen[0].url);
  assert.equal(u.searchParams.get("domain"), "acmeco.example.com");
  assert.equal(u.searchParams.get("limit"), "100");
  assert.equal(u.searchParams.get("api_key"), null);
  assert.equal(seen[0].headers["x-api-key"], "hk");
});

test("email-finder: returns email, score and a verdict from the verification block", async () => {
  const r = await hunterEmailFinder.call({ domain: "acmeco.example.com", firstName: "John", lastName: "Smith" }, { key: "hk", fetchImpl: fakeFetch([{ status: 200, body: fixture("hunter", "email-finder.json") }]) });
  assert.ok(r.ok);
  assert.equal(r.data.email, "john@acmeco.example.com");
  assert.equal(r.data.score, 91);
  assert.equal(r.data.verificationStatus, "valid");
  assert.equal(r.data.verdict, "deliverable");
  assert.deepEqual(r.data.sources, [{ uri: "https://acmeco.example.com/team" }]);
  assert.equal(r.costUnits, 1);
  const bad = await hunterEmailFinder.call({ domain: "acmeco.example.com", firstName: "", lastName: "Smith" }, { key: "hk", fetchImpl: fakeFetch([]) });
  assert.ok(!bad.ok);
});

test("email-verifier: accept_all becomes catch_all; flags are booleans", async () => {
  const r = await hunterEmailVerifier.call({ email: " John@AcmeCo.Example.com " }, { key: "hk", fetchImpl: fakeFetch([{ status: 200, body: fixture("hunter", "email-verifier.json") }]) });
  assert.ok(r.ok);
  assert.equal(r.data.verdict, "catch_all");
  assert.equal(r.data.status, "accept_all");
  assert.equal(r.data.acceptAll, true);
  assert.equal(r.data.smtpCheck, true);
  assert.equal(r.data.score, 62);
});

test("hunter: 429 → rateLimited with the provider's error text; missing key refused", async () => {
  const r = await hunterEmailVerifier.call({ email: "a@b.co" }, { key: "hk", fetchImpl: fakeFetch([{ status: 429, body: fixture("hunter", "error429.json") }]) });
  assert.ok(!r.ok);
  assert.equal(r.rateLimited, true);
  assert.match(r.error, /rate limit/);
  const none = await hunterDomainSearch.call({ domain: "b.co" }, { key: "", fetchImpl: fakeFetch([]) });
  assert.ok(!none.ok);
});
