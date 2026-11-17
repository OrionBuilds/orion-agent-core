// Typed CLARA → FRIDAY prospect lookups (plan 2026-09-30, PR 4b).
//
// Agent-Reach (LinkedIn via the owner's real session, Exa search, Jina page reads) is pinned to
// FRIDAY's `research-qa` role only — the owner decided CLARA never touches those accounts. CLARA's
// prospecting engine therefore asks FRIDAY, over the existing interagent boundary, and gets a
// STRUCTURED answer back. Until now every cross-agent call was free text through a chat endpoint
// (a prompt in, a paragraph out, a task minted as a side effect); a research stage needs typed
// fields with provenance and a budget report, and must never mint a task. This is that contract.
//
// Both handlers are read-only by construction (reach-guard's verb allowlist); neither returns an
// email or a phone number — LinkedIn exposes none, and scraping them is out of bounds anyway.

import { interagentAuthHeaders, type InteragentCaller } from "./index";

export const PROSPECT_LOOKUP_PATH = "/api/friday/prospect/lookup";

// ── LinkedIn lookup ──────────────────────────────────────────────────────────
export interface ProspectLinkedinLookupInput {
  company: { name: string; domain?: string; city?: string; state?: string };
  /** Titles to look for, most wanted first, e.g. ["Owner", "President", "General Manager"]. */
  personas: string[];
  /** Profile pages to open (each is one LinkedIn "view"); default 2, max 3. */
  max_profiles?: number;
  /** Also open the company page (one more "view") for headcount/founded/HQ. Default false. */
  include_company_profile?: boolean;
}

export interface ProspectPerson {
  full_name: string;
  title?: string;
  linkedin_url: string;
  location?: string;
  /** 0–1: 0.9 when a profile page was opened and the title matched a persona, lower for search-only hits. */
  confidence: number;
  source_url: string;
  observed_at: string;
  /** Which persona (from the request) this person matched, if any. */
  matched_persona?: string;
}

export interface ProspectLinkedinBudget {
  searches_used: number;
  views_used: number;
  remaining_today: { searches: number; views: number };
}

export interface ProspectLinkedinLookupResult {
  ok: true;
  kind: "prospect.linkedin_lookup";
  company_profile?: { linkedin_url: string; headcount?: string; founded?: string; hq?: string; description?: string };
  people: ProspectPerson[];
  budget: ProspectLinkedinBudget;
  /** Set when nothing was attempted or the lookup stopped early (budget, hours, lock, not logged in). */
  skipped_reason?: string;
  /** Raw text excerpts (≤ 4 KB each) of what reach-guard returned, so the caller's model can re-parse
   *  if the deterministic parser missed something. Untrusted content. */
  raw_excerpts: { call: string; text: string }[];
  observed_at: string;
}

// ── Web read / search (Jina / Exa through reach-guard) ───────────────────────
export interface ProspectWebReadInput {
  mode: "read" | "search";
  /** Required for mode "read". */
  url?: string;
  /** Required for mode "search". */
  query?: string;
  /** mode "search": 1–10, default 8. */
  num_results?: number;
}

export interface ProspectWebReadResult {
  ok: true;
  kind: "prospect.web_read";
  mode: "read" | "search";
  /** mode "read": the page as text (≤ 200 KB). */
  text?: string;
  /** mode "search". */
  results?: { title: string; url: string; snippet?: string; published?: string }[];
  fetched_at: string;
  source: "jina" | "exa";
}

// ── Request / response envelope ──────────────────────────────────────────────
export type ProspectLookupRequest =
  | { from: InteragentCaller; kind: "prospect.linkedin_lookup"; input: ProspectLinkedinLookupInput; ref?: string }
  | { from: InteragentCaller; kind: "prospect.web_read"; input: ProspectWebReadInput; ref?: string };

export interface ProspectLookupError {
  ok: false;
  kind: ProspectLookupRequest["kind"];
  error: string;
  /** reach-guard exit 64: refused by policy (cap, hours, disabled, kill switch). Do not retry today. */
  refused?: boolean;
  /** reach-guard exit 75: the platform pushed back and is locked (72 h). Stop and tell the owner. */
  locked?: boolean;
  /** reach-guard exit 69: owner must log in by hand. */
  not_logged_in?: boolean;
  /** The request itself was malformed (HTTP 400): fix it, don't retry as-is. */
  invalid_input?: boolean;
  budget?: ProspectLinkedinBudget;
}

export type ProspectLookupResponse = ProspectLinkedinLookupResult | ProspectWebReadResult | ProspectLookupError;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isProspectBudget(v: unknown): v is ProspectLinkedinBudget {
  return isObj(v) && isNum(v.searches_used) && isNum(v.views_used)
    && isObj(v.remaining_today) && isNum(v.remaining_today.searches) && isNum(v.remaining_today.views);
}
const isPerson = (v: unknown): v is ProspectPerson =>
  isObj(v) && isStr(v.full_name) && isStr(v.linkedin_url) && isNum(v.confidence) && isStr(v.source_url) && isStr(v.observed_at);
const isExcerpt = (v: unknown): boolean => isObj(v) && isStr(v.call) && isStr(v.text);
const isWebResult = (v: unknown): boolean => isObj(v) && isStr(v.title) && isStr(v.url);

/** Runtime shape check so a 2xx with a malformed body never reaches the engine as a success —
 *  every required field of the exported result types, nested ones included. */
export function isProspectLookupResponse(j: unknown): j is ProspectLookupResponse {
  if (!isObj(j) || typeof j.ok !== "boolean" || !isStr(j.kind)) return false;
  if (j.ok === false) return isStr(j.error) && (j.budget === undefined || isProspectBudget(j.budget));
  if (j.kind === "prospect.linkedin_lookup") {
    return Array.isArray(j.people) && j.people.every(isPerson)
      && isProspectBudget(j.budget)
      && Array.isArray(j.raw_excerpts) && j.raw_excerpts.every(isExcerpt)
      && isStr(j.observed_at)
      && (j.company_profile === undefined || (isObj(j.company_profile) && isStr(j.company_profile.linkedin_url)));
  }
  if (j.kind === "prospect.web_read") {
    return (j.mode === "read" || j.mode === "search") && isStr(j.fetched_at) && (j.source === "jina" || j.source === "exa")
      && (j.text === undefined || isStr(j.text))
      && (j.results === undefined || (Array.isArray(j.results) && j.results.every(isWebResult)));
  }
  return false;
}

/**
 * POST a prospect lookup to FRIDAY. Never throws. The default timeout is long on purpose: the guard
 * sleeps 45–120 s between LinkedIn calls, so a 2-profile lookup can take ~6 minutes. Callers that
 * hold a request open (a route handler) should run this detached and poll their own store instead.
 */
export async function postProspectLookup(
  baseUrl: string,
  req: ProspectLookupRequest,
  opts: { timeoutMs?: number; path?: string; fetchImpl?: typeof fetch } = {},
): Promise<ProspectLookupResponse> {
  const path = opts.path ?? PROSPECT_LOOKUP_PATH;
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const timeoutMs = opts.timeoutMs ?? (req.kind === "prospect.linkedin_lookup" ? 480_000 : 60_000);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify(req),
      signal: ctl.signal,
    });
    const text = await r.text();
    let j: unknown = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!r.ok) {
      const err = isObj(j) && typeof j.error === "string" ? j.error : `HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
      const flags = isObj(j) ? pickFlags(j) : {};
      // HTTP 400 is always a malformed request on our side, whether or not FRIDAY's body says so.
      if (r.status === 400) flags.invalid_input = true;
      return { ok: false, kind: req.kind, error: err, ...flags };
    }
    if (!isProspectLookupResponse(j)) return { ok: false, kind: req.kind, error: "malformed prospect lookup response" };
    return j;
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String((e as Error)?.message ?? e);
    return { ok: false, kind: req.kind, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function pickFlags(j: Record<string, unknown>): Partial<ProspectLookupError> {
  const out: Partial<ProspectLookupError> = {};
  if (j.refused === true) out.refused = true;
  if (j.locked === true) out.locked = true;
  if (j.not_logged_in === true) out.not_logged_in = true;
  if (j.invalid_input === true) out.invalid_input = true;
  if (isProspectBudget(j.budget)) out.budget = j.budget;
  return out;
}
