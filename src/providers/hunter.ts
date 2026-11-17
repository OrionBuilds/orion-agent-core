// Hunter.io v2 — domain search, email finder, email verifier. Lifted from FRIDAY's leads.ts
// (hunterDomainSearch / hunterFindEmail / hunterVerify), which keep working unchanged until FRIDAY
// migrates. Differences here: the key travels in the `X-API-KEY` header rather than the query
// string (so it never lands in access logs), errors are returned not thrown, and the verifier's
// three-bucket `result` is exposed as a normalized `verdict` alongside Hunter's raw `status`.
//
// Hunter bills per "request" on every plan, so costUnits is 1 per call.

import { providerFetch, missingKey, asObj, asStr, asNum, type ProviderClient, type ProviderResult } from "./types";

const BASE = "https://api.hunter.io/v2";

/** Strip scheme/path/www from a URL or hostname; empty when nothing usable remains. */
export function domainFrom(input: string): string {
  const s = input.trim().toLowerCase();
  if (!s) return "";
  const host = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : "";
}

/** Hunter's `result` (deliverable | risky | undeliverable) plus the finder's confidence, mapped onto
 *  one vocabulary the caller's verification state machine understands. */
export type HunterVerdict = "deliverable" | "risky" | "undeliverable" | "catch_all" | "unknown";
export function hunterVerdict(result?: string, status?: string): HunterVerdict {
  const st = (status ?? "").toLowerCase();
  if (st === "accept_all") return "catch_all";
  switch ((result ?? "").toLowerCase()) {
    case "deliverable": return "deliverable";
    case "risky": return "risky";
    case "undeliverable": return "undeliverable";
    default: return "unknown";
  }
}

// ── Domain search ────────────────────────────────────────────────────────────
export interface HunterDomainSearchRequest { domain: string; limit?: number; department?: string; seniority?: string }
export interface HunterPerson {
  email: string; firstName?: string; lastName?: string; position?: string; seniority?: string; department?: string;
  linkedin?: string; phone?: string; confidence?: number; type?: string; sources: { uri: string; extractedOn?: string }[];
}
export interface HunterDomainSearchResponse { organization?: string; pattern?: string; people: HunterPerson[]; total?: number }

export const hunterDomainSearch: ProviderClient<HunterDomainSearchRequest, HunterDomainSearchResponse> = {
  provider: "hunter",
  async call(req, opts): Promise<ProviderResult<HunterDomainSearchResponse>> {
    if (!opts.key) return missingKey("hunter");
    const d = domainFrom(req.domain);
    if (!d) return { ok: false, error: "hunter: domain required", costUnits: 0 };
    const p = new URLSearchParams({ domain: d, limit: String(Math.min(Math.max(req.limit ?? 10, 1), 100)) });
    if (req.department) p.set("department", req.department);
    if (req.seniority) p.set("seniority", req.seniority);
    const r = await providerFetch(`${BASE}/domain-search?${p}`, { headers: { Accept: "application/json", "X-API-KEY": opts.key } }, opts, 15_000);
    if (!r.ok) return r;
    const data = asObj(asObj(r.json).data);
    const people = (Array.isArray(data.emails) ? data.emails : []).map((e) => {
      const o = asObj(e);
      return {
        email: asStr(o.value) ?? "", firstName: asStr(o.first_name), lastName: asStr(o.last_name), position: asStr(o.position),
        seniority: asStr(o.seniority), department: asStr(o.department), linkedin: asStr(o.linkedin), phone: asStr(o.phone_number),
        confidence: asNum(o.confidence), type: asStr(o.type),
        sources: (Array.isArray(o.sources) ? o.sources : []).map((s) => ({ uri: asStr(asObj(s).uri) ?? "", extractedOn: asStr(asObj(s).extracted_on) })).filter((s) => s.uri),
      } satisfies HunterPerson;
    }).filter((x) => x.email);
    return {
      ok: true, raw: r.json, costUnits: 1, status: r.status,
      data: { organization: asStr(data.organization), pattern: asStr(data.pattern), people, total: asNum(asObj(asObj(r.json).meta).results) },
    };
  },
};

// ── Email finder ─────────────────────────────────────────────────────────────
export interface HunterEmailFinderRequest { domain: string; firstName: string; lastName: string }
export interface HunterEmailFinderResponse { email?: string; score?: number; verdict: HunterVerdict; verificationStatus?: string; sources: { uri: string }[] }

export const hunterEmailFinder: ProviderClient<HunterEmailFinderRequest, HunterEmailFinderResponse> = {
  provider: "hunter",
  async call(req, opts): Promise<ProviderResult<HunterEmailFinderResponse>> {
    if (!opts.key) return missingKey("hunter");
    const d = domainFrom(req.domain);
    if (!d || !req.firstName?.trim()) return { ok: false, error: "hunter: domain and firstName required", costUnits: 0 };
    const p = new URLSearchParams({ domain: d, first_name: req.firstName.trim(), last_name: (req.lastName ?? "").trim() });
    const r = await providerFetch(`${BASE}/email-finder?${p}`, { headers: { Accept: "application/json", "X-API-KEY": opts.key } }, opts, 15_000);
    if (!r.ok) return r;
    const data = asObj(asObj(r.json).data);
    const ver = asObj(data.verification);
    return {
      ok: true, raw: r.json, costUnits: 1, status: r.status,
      data: {
        email: asStr(data.email), score: asNum(data.score), verificationStatus: asStr(ver.status),
        // The finder's verification block uses "valid" / "invalid" / "accept_all" (not the verifier's
        // three-bucket `result`), so map those onto the shared verdict here.
        verdict: hunterVerdict(({ valid: "deliverable", invalid: "undeliverable" } as Record<string, string>)[asStr(ver.status) ?? ""], asStr(ver.status)),
        sources: (Array.isArray(data.sources) ? data.sources : []).map((s) => ({ uri: asStr(asObj(s).uri) ?? "" })).filter((s) => s.uri),
      },
    };
  },
};

// ── Email verifier ───────────────────────────────────────────────────────────
export interface HunterVerifyRequest { email: string }
export interface HunterVerifyResponse { email: string; verdict: HunterVerdict; status?: string; score?: number; acceptAll?: boolean; disposable?: boolean; webmail?: boolean; mxRecords?: boolean; smtpCheck?: boolean }

export const hunterEmailVerifier: ProviderClient<HunterVerifyRequest, HunterVerifyResponse> = {
  provider: "hunter",
  async call(req, opts): Promise<ProviderResult<HunterVerifyResponse>> {
    if (!opts.key) return missingKey("hunter");
    const email = req.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) return { ok: false, error: "hunter: email required", costUnits: 0 };
    const r = await providerFetch(`${BASE}/email-verifier?${new URLSearchParams({ email })}`, { headers: { Accept: "application/json", "X-API-KEY": opts.key } }, opts, 20_000);
    if (!r.ok) return r;
    const data = asObj(asObj(r.json).data);
    const status = asStr(data.status);
    const acceptAll = data.accept_all === true;
    return {
      ok: true, raw: r.json, costUnits: 1, status: r.status,
      data: {
        email: asStr(data.email) ?? email, status, score: asNum(data.score),
        verdict: hunterVerdict(asStr(data.result), acceptAll ? "accept_all" : status),
        acceptAll, disposable: data.disposable === true, webmail: data.webmail === true,
        mxRecords: data.mx_records === true, smtpCheck: data.smtp_check === true,
      },
    };
  },
};
