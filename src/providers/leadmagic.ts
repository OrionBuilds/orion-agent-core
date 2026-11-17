// LeadMagic — email finder, mobile finder, email validation. Shapes from the published OpenAPI spec
// (https://docs.leadmagic.io/openapi.json, v1.4.35, 2026-09-30): base `https://api.leadmagic.io`,
// auth header `X-API-Key`, JSON POST bodies, `credits_consumed` on every 200. LeadMagic charges
// only on a hit (an email/mobile found), which is why `costUnits` comes from the response rather
// than a constant. 402 = out of credits, 429 = rate limit — both surface as `rateLimited`.
//
// Fair-use note from the spec: a sustained email-finder hit rate under 10% can get the key
// throttled or suspended, so the caller must gate finder calls behind qualification (plan §14/§20)
// and never brute-force guesses.

import { providerFetch, missingKey, asObj, asStr, asNum, type ProviderClient, type ProviderResult } from "./types";

const BASE = "https://api.leadmagic.io";

function headers(key: string): Record<string, string> {
  return { "Content-Type": "application/json", Accept: "application/json", "X-API-Key": key };
}

/** LeadMagic's free-text statuses ("valid", "valid_catch_all", "catch_all", "invalid", "not_found",
 *  "unknown", …) mapped onto the vocabulary the caller's verification state machine uses. */
export type LeadMagicVerdict = "deliverable" | "catch_all" | "undeliverable" | "not_found" | "unknown";
export function leadmagicVerdict(status?: string, email?: string): LeadMagicVerdict {
  const s = (status ?? "").toLowerCase();
  if (s.includes("catch")) return "catch_all";
  if (s.includes("invalid") || s.includes("undeliverable")) return "undeliverable";
  if (s.includes("not_found") || s.includes("not found") || (!email && !s)) return "not_found";
  if (s.includes("valid") || s === "ok" || s === "deliverable") return "deliverable";
  return email ? "unknown" : "not_found";
}

// ── Email finder ─────────────────────────────────────────────────────────────
export interface LeadMagicEmailFinderRequest {
  firstName?: string; lastName?: string; fullName?: string;
  domain?: string; companyName?: string;
  /** B2B profile URL or username — identifies person + company on its own. */
  profileUrl?: string;
  /** Default false: an email on an unrelated domain is flagged, not returned as a hit. */
  allowDomainMismatch?: boolean;
}
export interface LeadMagicEmailFinderResponse {
  email?: string; status?: string; verdict: LeadMagicVerdict; message?: string;
  employmentVerified?: boolean; domainMismatch?: boolean; requestedDomain?: string; domain?: string;
  mxProvider?: string; companyName?: string; companyProfileUrl?: string; credits: number;
}

export const leadmagicEmailFinder: ProviderClient<LeadMagicEmailFinderRequest, LeadMagicEmailFinderResponse> = {
  provider: "leadmagic",
  async call(req, opts): Promise<ProviderResult<LeadMagicEmailFinderResponse>> {
    if (!opts.key) return missingKey("leadmagic");
    const hasName = Boolean(req.fullName?.trim() || req.firstName?.trim());
    const hasCompany = Boolean(req.domain?.trim() || req.companyName?.trim());
    if (!req.profileUrl?.trim() && !(hasName && hasCompany)) {
      return { ok: false, error: "leadmagic: need profileUrl, or a name plus domain/companyName", costUnits: 0 };
    }
    const body: Record<string, unknown> = {};
    if (req.firstName?.trim()) body.first_name = req.firstName.trim();
    if (req.lastName?.trim()) body.last_name = req.lastName.trim();
    if (req.fullName?.trim()) body.full_name = req.fullName.trim();
    if (req.domain?.trim()) body.domain = req.domain.trim().toLowerCase();
    if (req.companyName?.trim()) body.company_name = req.companyName.trim();
    if (req.profileUrl?.trim()) body.profile_url = req.profileUrl.trim();
    if (req.allowDomainMismatch !== undefined) body.allow_domain_mismatch = req.allowDomainMismatch;
    const r = await providerFetch(`${BASE}/v1/people/email-finder`, { method: "POST", headers: headers(opts.key), body: JSON.stringify(body) }, opts, 20_000);
    if (!r.ok) return r;
    const j = asObj(r.json);
    const email = asStr(j.email);
    const status = asStr(j.status);
    return {
      ok: true, raw: r.json, status: r.status, costUnits: asNum(j.credits_consumed) ?? 0,
      data: {
        email, status, verdict: leadmagicVerdict(status, email), message: asStr(j.message),
        employmentVerified: typeof j.employment_verified === "boolean" ? j.employment_verified : undefined,
        domainMismatch: j.domain_mismatch === true, requestedDomain: asStr(j.requested_domain), domain: asStr(j.domain),
        mxProvider: asStr(j.mx_provider), companyName: asStr(j.company_name), companyProfileUrl: asStr(j.company_profile_url),
        credits: asNum(j.credits_consumed) ?? 0,
      },
    };
  },
};

// ── Mobile finder ────────────────────────────────────────────────────────────
export interface LeadMagicMobileFinderRequest { profileUrl?: string; workEmail?: string; personalEmail?: string }
export interface LeadMagicMobileFinderResponse { mobile?: string; message?: string; credits: number }

export const leadmagicMobileFinder: ProviderClient<LeadMagicMobileFinderRequest, LeadMagicMobileFinderResponse> = {
  provider: "leadmagic",
  async call(req, opts): Promise<ProviderResult<LeadMagicMobileFinderResponse>> {
    if (!opts.key) return missingKey("leadmagic");
    if (!req.profileUrl?.trim() && !req.workEmail?.trim() && !req.personalEmail?.trim()) {
      return { ok: false, error: "leadmagic: need profileUrl, workEmail or personalEmail", costUnits: 0 };
    }
    const body: Record<string, unknown> = {};
    if (req.profileUrl?.trim()) body.profile_url = req.profileUrl.trim();
    if (req.workEmail?.trim()) body.work_email = req.workEmail.trim().toLowerCase();
    if (req.personalEmail?.trim()) body.personal_email = req.personalEmail.trim().toLowerCase();
    const r = await providerFetch(`${BASE}/v1/people/mobile-finder`, { method: "POST", headers: headers(opts.key), body: JSON.stringify(body) }, opts, 20_000);
    if (!r.ok) return r;
    const j = asObj(r.json);
    const mobile = asStr(j.mobile_number);
    return {
      ok: true, raw: r.json, status: r.status, costUnits: asNum(j.credits_consumed) ?? 0,
      data: { mobile: mobile ? mobile.replace(/[^\d+]/g, "") || undefined : undefined, message: asStr(j.message), credits: asNum(j.credits_consumed) ?? 0 },
    };
  },
};

// ── Email validation ─────────────────────────────────────────────────────────
export interface LeadMagicValidateRequest { email: string }
export interface LeadMagicValidateResponse {
  email: string; status?: string; verdict: LeadMagicVerdict; message?: string;
  mxProvider?: string; mxRecord?: string; securityGateway?: boolean; companyName?: string; credits: number;
}

export const leadmagicEmailValidate: ProviderClient<LeadMagicValidateRequest, LeadMagicValidateResponse> = {
  provider: "leadmagic",
  async call(req, opts): Promise<ProviderResult<LeadMagicValidateResponse>> {
    if (!opts.key) return missingKey("leadmagic");
    const email = req.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) return { ok: false, error: "leadmagic: email required", costUnits: 0 };
    const r = await providerFetch(`${BASE}/v1/people/email-validation`, { method: "POST", headers: headers(opts.key), body: JSON.stringify({ email }) }, opts, 20_000);
    if (!r.ok) return r;
    const j = asObj(r.json);
    const status = asStr(j.email_status);
    return {
      ok: true, raw: r.json, status: r.status, costUnits: asNum(j.credits_consumed) ?? 0,
      data: {
        email: asStr(j.email) ?? email, status, verdict: leadmagicVerdict(status, email), message: asStr(j.message),
        mxProvider: asStr(j.mx_provider), mxRecord: asStr(j.mx_record), securityGateway: j.mx_security_gateway === true,
        companyName: asStr(j.company_name), credits: asNum(j.credits_consumed) ?? 0,
      },
    };
  },
};

// ── Credits ──────────────────────────────────────────────────────────────────
export const leadmagicCredits: ProviderClient<Record<string, never>, { credits: number }> = {
  provider: "leadmagic",
  async call(_req, opts): Promise<ProviderResult<{ credits: number }>> {
    if (!opts.key) return missingKey("leadmagic");
    const r = await providerFetch(`${BASE}/v1/credits`, { method: "POST", headers: headers(opts.key), body: "{}" }, opts, 10_000);
    if (!r.ok) return r;
    return { ok: true, raw: r.json, status: r.status, costUnits: 0, data: { credits: asNum(asObj(r.json).credits) ?? 0 } };
  },
};
