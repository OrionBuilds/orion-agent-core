import { test } from "node:test";
import assert from "node:assert/strict";
import { googlePlacesSearch, googlePlacesSearchAll } from "./googlePlaces";
import { fixture, fakeFetch, hangingFetch, type Seen } from "./testUtil";

const page1 = fixture("googlePlaces", "searchText.page1.json");
const page2 = fixture("googlePlaces", "searchText.page2.json");
const err429 = fixture("googlePlaces", "error429.json");

test("places: parses a page into normalized results, drops rows without an id, costs 1 per page", async () => {
  const seen: Seen[] = [];
  const r = await googlePlacesSearch.call(
    { textQuery: "roofing contractor", location: { lat: 27.95, lng: -82.45, radiusMeters: 20_000 }, restrict: true },
    { key: "k", fetchImpl: fakeFetch([{ status: 200, body: page1 }], seen) },
  );
  assert.ok(r.ok);
  assert.equal(r.costUnits, 1);
  assert.equal(r.data.places.length, 2);
  assert.equal(r.data.nextPageToken, "AeJbb3kP2");
  const [a, b] = r.data.places;
  assert.deepEqual({ ...a }, {
    placeId: "ChIJabc123", name: "Acme Co", formattedAddress: "123 Main St, Springfield, IL 62701, USA", phoneE164: "+18135550100",
    rating: 4.8, userRatingCount: 412, businessStatus: "OPERATIONAL", websiteUri: "https://acmeco.example.com/", googleMapsUri: "https://maps.google.com/?cid=1",
    primaryType: "roofing_contractor", types: ["roofing_contractor", "point_of_interest"], location: { lat: 27.9506, lng: -82.4572 }, openNow: undefined, hoursWeekly: undefined,
  });
  assert.equal(b.businessStatus, "CLOSED_TEMPORARILY");
  assert.equal(b.phoneE164, undefined);
  // The request: key in the header, restriction (not bias), field mask asks for the paging token.
  assert.equal(seen[0].headers["x-goog-api-key"], "k");
  const body = JSON.parse(seen[0].body!);
  assert.equal(body.locationRestriction.circle.radius, 20_000);
  assert.equal(body.locationBias, undefined);
  assert.match(seen[0].headers["x-goog-fieldmask"], /nextPageToken/);
  assert.doesNotMatch(seen[0].headers["x-goog-fieldmask"], /regularOpeningHours/);
});

test("places: bias by default, hours fields only when asked, radius capped at 50 km, page token forwarded", async () => {
  const seen: Seen[] = [];
  await googlePlacesSearch.call(
    { textQuery: "roofer", location: { lat: 1, lng: 2, radiusMeters: 99_000 }, includeHours: true, pageToken: "tok", pageSize: 50 },
    { key: "k", fetchImpl: fakeFetch([{ status: 200, body: page2 }], seen) },
  );
  const body = JSON.parse(seen[0].body!);
  assert.equal(body.locationBias.circle.radius, 50_000);
  assert.equal(body.locationRestriction, undefined);
  assert.equal(body.pageToken, "tok");
  assert.equal(body.pageSize, 20);
  assert.match(seen[0].headers["x-goog-fieldmask"], /regularOpeningHours/);
});

test("places: 429 → rateLimited, no cost; missing key refused before any request", async () => {
  const seen: Seen[] = [];
  const r = await googlePlacesSearch.call({ textQuery: "x" }, { key: "k", fetchImpl: fakeFetch([{ status: 429, body: err429 }], seen) });
  assert.ok(!r.ok);
  assert.equal(r.rateLimited, true);
  assert.equal(r.status, 429);
  assert.equal(r.costUnits, 0);
  const none = await googlePlacesSearch.call({ textQuery: "x" }, { key: "", fetchImpl: fakeFetch([], seen) });
  assert.ok(!none.ok);
  assert.equal(seen.length, 1);
});

test("places: timeout surfaces as an error, never a hang; a caller abort is reported as such and sends nothing", async () => {
  const r = await googlePlacesSearch.call({ textQuery: "x" }, { key: "k", fetchImpl: hangingFetch(), timeoutMs: 20 });
  assert.ok(!r.ok);
  assert.match(r.error, /timeout/);
  const seen: Seen[] = [];
  const pre = new AbortController(); pre.abort();
  const a = await googlePlacesSearch.call({ textQuery: "x" }, { key: "k", fetchImpl: fakeFetch([{ status: 200, body: page1 }], seen), signal: pre.signal });
  assert.ok(!a.ok && a.error === "aborted by caller");
  assert.equal(seen.length, 0);
  const mid = new AbortController();
  const p = googlePlacesSearch.call({ textQuery: "x" }, { key: "k", fetchImpl: hangingFetch(), timeoutMs: 5_000, signal: mid.signal });
  mid.abort();
  const m = await p;
  assert.ok(!m.ok && m.error === "aborted by caller");
});

test("placesSearchAll: follows nextPageToken, counts pages as cost, and keeps partial results on a later failure", async () => {
  const seen: Seen[] = [];
  const all = await googlePlacesSearchAll({ textQuery: "roofing contractor" }, { key: "k", fetchImpl: fakeFetch([{ status: 200, body: page1 }, { status: 200, body: page2 }], seen) });
  assert.ok(all.ok);
  assert.equal(all.data.pages, 2);
  assert.equal(all.costUnits, 2);
  assert.equal(all.data.places.length, 3);
  assert.equal(JSON.parse(seen[1].body!).pageToken, "AeJbb3kP2");

  const partial = await googlePlacesSearchAll({ textQuery: "roofing contractor" }, { key: "k", fetchImpl: fakeFetch([{ status: 200, body: page1 }, { status: 429, body: err429 }]) });
  assert.ok(partial.ok);
  assert.equal(partial.data.partial, true);
  assert.equal(partial.data.places.length, 2);
  assert.equal(partial.costUnits, 1);

  const capped = await googlePlacesSearchAll({ textQuery: "roofing contractor" }, { key: "k", fetchImpl: fakeFetch([{ status: 200, body: page1 }, { status: 200, body: page2 }]) }, 1);
  assert.ok(capped.ok);
  assert.equal(capped.data.places.length, 1);
  assert.equal(capped.data.pages, 1);
});
