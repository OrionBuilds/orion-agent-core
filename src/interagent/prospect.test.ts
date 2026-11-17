import { test } from "node:test";
import assert from "node:assert/strict";
import { postProspectLookup, isProspectLookupResponse, PROSPECT_LOOKUP_PATH, type ProspectLookupRequest, type ProspectLinkedinLookupResult } from "./prospect";

const linkedinReq: ProspectLookupRequest = {
  from: "clara", kind: "prospect.linkedin_lookup", ref: "job1:c9",
  input: { company: { name: "Acme Co", domain: "acmeco.example.com", city: "Springfield", state: "IL" }, personas: ["Owner", "President"], max_profiles: 2 },
};
const okResult: ProspectLinkedinLookupResult = {
  ok: true, kind: "prospect.linkedin_lookup", people: [], budget: { searches_used: 2, views_used: 0, remaining_today: { searches: 8, views: 25 } },
  raw_excerpts: [], observed_at: "2026-09-30T14:00:00Z",
};

function fetchReturning(status: number, body: unknown, capture?: { url?: string; body?: string; headers?: Record<string, string> }): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (capture) {
      capture.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capture.body = typeof init?.body === "string" ? init.body : undefined;
      capture.headers = {}; new Headers(init?.headers).forEach((v, k) => { capture.headers![k] = v; });
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return impl as typeof fetch;
}

test("postProspectLookup posts to /api/friday/prospect/lookup with the interagent secret and returns the typed result", async () => {
  process.env.INTERAGENT_SHARED_SECRET = "s3cret";
  try {
    const cap: { url?: string; body?: string; headers?: Record<string, string> } = {};
    const r = await postProspectLookup("http://127.0.0.1:3737/", linkedinReq, { fetchImpl: fetchReturning(200, okResult, cap) });
    assert.equal(cap.url, `http://127.0.0.1:3737${PROSPECT_LOOKUP_PATH}`);
    assert.equal(cap.headers?.["x-interagent-secret"], "s3cret");
    assert.equal(JSON.parse(cap.body!).kind, "prospect.linkedin_lookup");
    assert.deepEqual(r, okResult);
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("postProspectLookup never throws: HTTP errors carry the receiver's flags, malformed 2xx is an error", async () => {
  const refused = await postProspectLookup("http://x", linkedinReq, { fetchImpl: fetchReturning(429, { ok: false, kind: "prospect.linkedin_lookup", error: "cap reached", refused: true, budget: { searches_used: 10, views_used: 3, remaining_today: { searches: 0, views: 22 } } }) });
  assert.ok(!refused.ok);
  assert.equal(refused.refused, true);
  assert.equal(refused.budget?.remaining_today.searches, 0);
  assert.equal(refused.error, "cap reached");
  // A malformed budget on an error response is dropped rather than cast.
  const halfBudget = await postProspectLookup("http://x", linkedinReq, { fetchImpl: fetchReturning(429, { ok: false, kind: "prospect.linkedin_lookup", error: "cap", refused: true, budget: { searches_used: 10 } }) });
  assert.ok(!halfBudget.ok && halfBudget.refused === true && halfBudget.budget === undefined);

  const malformed = await postProspectLookup("http://x", linkedinReq, { fetchImpl: fetchReturning(200, { ok: true, kind: "prospect.linkedin_lookup" }) });
  assert.ok(!malformed.ok);
  assert.match(malformed.error, /malformed/);

  const timedOut = await postProspectLookup("http://x", { from: "clara", kind: "prospect.web_read", input: { mode: "read", url: "https://a.b" } }, {
    timeoutMs: 20,
    fetchImpl: ((_i: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))))) as unknown as typeof fetch,
  });
  assert.ok(!timedOut.ok);
  assert.match(timedOut.error, /timeout/);
});

test("HTTP 400 always flags invalid_input, even when the body omits it", async () => {
  const bare = await postProspectLookup("http://x", linkedinReq, { fetchImpl: fetchReturning(400, { error: "bad request" }) });
  assert.ok(!bare.ok);
  assert.equal(bare.invalid_input, true);
  assert.equal(bare.error, "bad request");

  // An explicit false/absent flag in the body never overrides the status-derived truth.
  const noBody = await postProspectLookup("http://x", linkedinReq, { fetchImpl: fetchReturning(400, "") });
  assert.ok(!noBody.ok);
  assert.equal(noBody.invalid_input, true);
});

test("isProspectLookupResponse accepts both result kinds and rejects shape drift", () => {
  assert.ok(isProspectLookupResponse(okResult));
  assert.ok(isProspectLookupResponse({ ok: true, kind: "prospect.web_read", mode: "search", results: [], fetched_at: "t", source: "exa" }));
  assert.ok(isProspectLookupResponse({ ok: false, kind: "prospect.web_read", error: "nope" }));
  assert.ok(!isProspectLookupResponse({ ok: true, kind: "prospect.web_read", mode: "browse", fetched_at: "t" }));
  assert.ok(!isProspectLookupResponse({ ok: true, kind: "other" }));
  // Nested shape drift is rejected too: a person without a url, a budget without remaining_today,
  // a search result without a url, an unknown source.
  assert.ok(!isProspectLookupResponse({ ...okResult, people: [{ full_name: "x" }] }));
  assert.ok(!isProspectLookupResponse({ ...okResult, budget: { searches_used: 1, views_used: 0 } }));
  assert.ok(!isProspectLookupResponse({ ok: true, kind: "prospect.web_read", mode: "search", results: [{ title: "t" }], fetched_at: "t", source: "exa" }));
  assert.ok(!isProspectLookupResponse({ ok: true, kind: "prospect.web_read", mode: "read", text: "x", fetched_at: "t", source: "bing" }));
  assert.ok(!isProspectLookupResponse("nope"));
});
