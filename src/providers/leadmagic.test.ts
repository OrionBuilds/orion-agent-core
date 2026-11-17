import { test } from "node:test";
import assert from "node:assert/strict";
import { leadmagicEmailFinder, leadmagicMobileFinder, leadmagicEmailValidate, leadmagicCredits, leadmagicVerdict } from "./leadmagic";
import { fixture, fakeFetch, type Seen } from "./testUtil";

test("leadmagicVerdict maps LeadMagic's statuses", () => {
  assert.equal(leadmagicVerdict("valid", "a@b.co"), "deliverable");
  assert.equal(leadmagicVerdict("valid_catch_all", "a@b.co"), "catch_all");
  assert.equal(leadmagicVerdict("catch_all", "a@b.co"), "catch_all");
  assert.equal(leadmagicVerdict("invalid", "a@b.co"), "undeliverable");
  assert.equal(leadmagicVerdict("not_found", undefined), "not_found");
  assert.equal(leadmagicVerdict(undefined, undefined), "not_found");
  assert.equal(leadmagicVerdict("weird", "a@b.co"), "unknown");
});

test("email-finder: hit → email + verdict + credits from the response; POST JSON with X-API-Key", async () => {
  const seen: Seen[] = [];
  const r = await leadmagicEmailFinder.call({ firstName: "John", lastName: "Smith", domain: "AcmeCo.Example.com" }, { key: "lm", fetchImpl: fakeFetch([{ status: 200, body: fixture("leadmagic", "email-finder.json") }], seen) });
  assert.ok(r.ok);
  assert.equal(r.data.email, "john@acmeco.example.com");
  assert.equal(r.data.verdict, "deliverable");
  assert.equal(r.data.employmentVerified, true);
  assert.equal(r.data.companyProfileUrl, "https://www.linkedin.com/company/acme-co");
  assert.equal(r.costUnits, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "https://api.leadmagic.io/v1/people/email-finder");
  assert.equal(seen[0].headers["x-api-key"], "lm");
  assert.deepEqual(JSON.parse(seen[0].body!), { first_name: "John", last_name: "Smith", domain: "acmeco.example.com" });
});

test("email-finder: miss → not_found and zero cost; input needs a name+company or a profile url", async () => {
  const r = await leadmagicEmailFinder.call({ fullName: "Jane Doe", companyName: "Acme Co" }, { key: "lm", fetchImpl: fakeFetch([{ status: 200, body: fixture("leadmagic", "email-finder.notfound.json") }]) });
  assert.ok(r.ok);
  assert.equal(r.data.email, undefined);
  assert.equal(r.data.verdict, "not_found");
  assert.equal(r.costUnits, 0);
  const bad = await leadmagicEmailFinder.call({ firstName: "Jane" }, { key: "lm", fetchImpl: fakeFetch([]) });
  assert.ok(!bad.ok);
  const byUrl = await leadmagicEmailFinder.call({ profileUrl: "https://www.linkedin.com/in/janedoe" }, { key: "lm", fetchImpl: fakeFetch([{ status: 200, body: fixture("leadmagic", "email-finder.notfound.json") }]) });
  assert.ok(byUrl.ok);
});

test("mobile-finder: normalizes the number and reports the credits charged", async () => {
  const r = await leadmagicMobileFinder.call({ profileUrl: "https://www.linkedin.com/in/johnsmithacme", workEmail: "John@AcmeCo.Example.com" }, { key: "lm", fetchImpl: fakeFetch([{ status: 200, body: fixture("leadmagic", "mobile-finder.json") }]) });
  assert.ok(r.ok);
  assert.equal(r.data.mobile, "+18135550142");
  assert.equal(r.costUnits, 5);
  const bad = await leadmagicMobileFinder.call({}, { key: "lm", fetchImpl: fakeFetch([]) });
  assert.ok(!bad.ok);
});

test("email-validation: catch-all status, fractional credits, MX provider", async () => {
  const r = await leadmagicEmailValidate.call({ email: "info@acmeco.example.com" }, { key: "lm", fetchImpl: fakeFetch([{ status: 200, body: fixture("leadmagic", "email-validation.json") }]) });
  assert.ok(r.ok);
  assert.equal(r.data.verdict, "catch_all");
  assert.equal(r.data.mxProvider, "Google");
  assert.equal(r.costUnits, 0.05);
});

test("leadmagic: 402 (out of credits) → rateLimited; missing key refused; credits endpoint", async () => {
  const r = await leadmagicEmailValidate.call({ email: "a@b.co" }, { key: "lm", fetchImpl: fakeFetch([{ status: 402, body: fixture("leadmagic", "error402.json") }]) });
  assert.ok(!r.ok);
  assert.equal(r.rateLimited, true);
  assert.equal(r.status, 402);
  assert.ok(!(await leadmagicEmailValidate.call({ email: "a@b.co" }, { key: "", fetchImpl: fakeFetch([]) })).ok);
  const c = await leadmagicCredits.call({}, { key: "lm", fetchImpl: fakeFetch([{ status: 200, body: '{"credits": 1234.5}' }]) });
  assert.ok(c.ok);
  assert.equal(c.data.credits, 1234.5);
  assert.equal(c.costUnits, 0);
});
