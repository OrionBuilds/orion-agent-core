// Google Places API (New) — text search with location restriction and paging.
//
// Lifted from CLARA's places.ts (which stays as-is for her conversational lookup) and extended for
// the prospecting grid: `locationRestriction` (a hard circle, not a bias) so a cell returns only
// businesses inside it, and `pageToken` paging up to Google's 60-result ceiling per query.
// Pricing is per request (Text Search Pro/Enterprise SKU depending on the field mask), so
// `costUnits` is 1 per page fetched.

import { providerFetch, missingKey, asObj, asStr, asNum, type ProviderClient, type ProviderCallOpts, type ProviderResult } from "./types";

export interface PlacesSearchRequest {
  textQuery: string;
  /** Circle to search inside (restriction) or around (bias). Radius in meters, ≤ 50 000. */
  location?: { lat: number; lng: number; radiusMeters: number };
  /** true ⇒ locationRestriction (results must be inside); false/undefined ⇒ locationBias. */
  restrict?: boolean;
  /** 1–20; Google returns at most 20 per page and 60 per query. */
  pageSize?: number;
  pageToken?: string;
  includeHours?: boolean;
  /** Override the field mask entirely (advanced; affects the SKU billed). */
  fieldMask?: string;
}

export interface PlaceResult {
  placeId: string;
  name: string;
  formattedAddress?: string;
  phoneE164?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string; // OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY
  websiteUri?: string;
  googleMapsUri?: string;
  primaryType?: string;
  types?: string[];
  location?: { lat: number; lng: number };
  openNow?: boolean;
  hoursWeekly?: string[];
}

export interface PlacesSearchResponse {
  places: PlaceResult[];
  nextPageToken?: string;
}

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const BASE_FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.internationalPhoneNumber",
  "places.rating", "places.userRatingCount", "places.businessStatus", "places.websiteUri",
  "places.googleMapsUri", "places.primaryType", "places.types", "places.location", "nextPageToken",
].join(",");
const HOURS_FIELDS = "places.regularOpeningHours.weekdayDescriptions,places.currentOpeningHours.openNow";

function toE164(raw: string): string | undefined {
  const cleaned = raw.replace(/[^\d+]/g, "");
  return cleaned || undefined;
}

export const googlePlacesSearch: ProviderClient<PlacesSearchRequest, PlacesSearchResponse> = {
  provider: "places",
  async call(req, opts): Promise<ProviderResult<PlacesSearchResponse>> {
    if (!opts.key) return missingKey("places");
    if (!req.textQuery?.trim()) return { ok: false, error: "places: textQuery required", costUnits: 0 };
    const body: Record<string, unknown> = { textQuery: req.textQuery.trim(), pageSize: Math.min(Math.max(req.pageSize ?? 20, 1), 20) };
    if (req.location) {
      const circle = { circle: { center: { latitude: req.location.lat, longitude: req.location.lng }, radius: Math.min(req.location.radiusMeters, 50_000) } };
      if (req.restrict) body.locationRestriction = circle; else body.locationBias = circle;
    }
    if (req.pageToken) body.pageToken = req.pageToken;
    const r = await providerFetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": opts.key,
        "X-Goog-FieldMask": req.fieldMask ?? (req.includeHours ? `${BASE_FIELDS},${HOURS_FIELDS}` : BASE_FIELDS),
      },
      body: JSON.stringify(body),
    }, opts, 10_000);
    if (!r.ok) return r;
    const j = asObj(r.json);
    const places = (Array.isArray(j.places) ? j.places : []).map((p) => {
      const o = asObj(p);
      const loc = asObj(o.location);
      const lat = asNum(loc.latitude), lng = asNum(loc.longitude);
      return {
        placeId: asStr(o.id) ?? "",
        name: asStr(asObj(o.displayName).text) ?? "Unknown business",
        formattedAddress: asStr(o.formattedAddress),
        phoneE164: asStr(o.internationalPhoneNumber) ? toE164(asStr(o.internationalPhoneNumber)!) : undefined,
        rating: asNum(o.rating),
        userRatingCount: asNum(o.userRatingCount),
        businessStatus: asStr(o.businessStatus),
        websiteUri: asStr(o.websiteUri),
        googleMapsUri: asStr(o.googleMapsUri),
        primaryType: asStr(o.primaryType),
        types: Array.isArray(o.types) ? o.types.filter((t): t is string => typeof t === "string") : undefined,
        location: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
        openNow: typeof asObj(o.currentOpeningHours).openNow === "boolean" ? (asObj(o.currentOpeningHours).openNow as boolean) : undefined,
        hoursWeekly: Array.isArray(asObj(o.regularOpeningHours).weekdayDescriptions) ? (asObj(o.regularOpeningHours).weekdayDescriptions as string[]) : undefined,
      } satisfies PlaceResult;
    }).filter((p) => p.placeId);
    return { ok: true, data: { places, nextPageToken: asStr(j.nextPageToken) }, raw: r.json, costUnits: 1, status: r.status };
  },
};

/**
 * Follow `nextPageToken` until Google stops (max 3 pages = 60 results) or `maxResults` is reached.
 * Each page is one billed request; the returned `costUnits` is the page count. A failed later page
 * returns what was gathered so far with `partial: true` rather than throwing it all away.
 */
export async function googlePlacesSearchAll(
  req: Omit<PlacesSearchRequest, "pageToken">,
  opts: ProviderCallOpts,
  maxResults = 60,
): Promise<ProviderResult<PlacesSearchResponse & { pages: number; partial?: boolean }>> {
  const places: PlaceResult[] = [];
  let token: string | undefined;
  let pages = 0;
  let last: unknown = null;
  for (let i = 0; i < 3 && places.length < maxResults; i++) {
    const r = await googlePlacesSearch.call({ ...req, pageToken: token }, opts);
    if (!r.ok) {
      if (pages === 0) return r;
      return { ok: true, data: { places, nextPageToken: token, pages, partial: true }, raw: last, costUnits: pages, status: 200 };
    }
    pages += 1; last = r.raw;
    places.push(...r.data.places);
    token = r.data.nextPageToken;
    if (!token) break;
  }
  return { ok: true, data: { places: places.slice(0, maxResults), nextPageToken: token, pages }, raw: last, costUnits: pages, status: 200 };
}
