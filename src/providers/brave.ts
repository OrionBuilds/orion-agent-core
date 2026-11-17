// Brave Search API — general web search. Lifted from CLARA's brave-search.ts (which keeps its own
// env-reading wrapper for the conversational `web_search` tool). Billed per query.

import { providerFetch, missingKey, asObj, asStr, type ProviderClient, type ProviderResult } from "./types";

export interface BraveSearchRequest {
  query: string;
  /** 1–20 results (Brave's per-page ceiling). */
  count?: number;
  /** Zero-based page offset (Brave allows 0–9). */
  offset?: number;
  /** e.g. "us"; Brave defaults to US. */
  country?: string;
  /** Freshness filter: "pd" (day), "pw" (week), "pm" (month), "py" (year). */
  freshness?: "pd" | "pw" | "pm" | "py";
}

export interface WebResult { title: string; url: string; snippet?: string; age?: string }
export interface BraveSearchResponse { results: WebResult[] }

const API_URL = "https://api.search.brave.com/res/v1/web/search";

export const braveSearch: ProviderClient<BraveSearchRequest, BraveSearchResponse> = {
  provider: "brave",
  async call(req, opts): Promise<ProviderResult<BraveSearchResponse>> {
    if (!opts.key) return missingKey("brave");
    const q = req.query?.trim();
    if (!q) return { ok: false, error: "brave: query required", costUnits: 0 };
    const params = new URLSearchParams({ q, count: String(Math.min(Math.max(req.count ?? 10, 1), 20)) });
    if (req.offset) params.set("offset", String(Math.min(Math.max(req.offset, 0), 9)));
    if (req.country) params.set("country", req.country);
    if (req.freshness) params.set("freshness", req.freshness);
    const r = await providerFetch(`${API_URL}?${params.toString()}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": opts.key },
    }, opts, 10_000);
    if (!r.ok) return r;
    const web = asObj(asObj(r.json).web);
    const results = (Array.isArray(web.results) ? web.results : []).map((x) => {
      const o = asObj(x);
      return { title: asStr(o.title) ?? "", url: asStr(o.url) ?? "", snippet: asStr(o.description), age: asStr(o.age) };
    }).filter((x) => x.title && x.url);
    return { ok: true, data: { results }, raw: r.json, costUnits: 1, status: r.status };
  },
};
