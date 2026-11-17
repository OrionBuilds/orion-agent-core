// Outbound helpers for the two typed cross-agent calls added 2026-09-24: `escalate` (FRIDAY
// → CLARA, the only path by which an emergency may reach the owner) and `status` (a
// structured project/client status request). Both are fire-and-report: they never throw, they
// time out, and the caller decides the fallback (for escalations: email the owner, never SMS).

import {
  interagentAuthHeaders,
  type EscalationRequest,
  type EscalationResponse,
  type StatusRequest,
  type StatusResult,
} from "./index";

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<{ ok: true; json: T; status: number } | { ok: false; error: string; status?: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    // No inner catch: a body that stalls until the abort must surface as a timeout, not as an
    // empty (and therefore "successful") response.
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    return { ok: true, json: json as T, status: r.status };
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String((e as Error)?.message ?? e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** POST an escalation to CLARA (`/api/agent/escalate`). Never throws. */
export async function postEscalation(
  baseUrl: string,
  req: EscalationRequest,
  opts: { timeoutMs?: number; path?: string } = {},
): Promise<EscalationResponse> {
  const path = opts.path ?? "/api/agent/escalate";
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const r = await postJson<Partial<EscalationResponse>>(url, req, opts.timeoutMs ?? 8_000);
  if (!r.ok) return { ok: false, via: path, error: r.error };
  const j = r.json;
  // A 2xx with an empty or malformed body is NOT a receipt: the caller's email fallback must run.
  if (!j || typeof j !== "object" || typeof j.ok !== "boolean") return { ok: false, via: path, error: "malformed escalation response" };
  return { ok: j.ok === true, id: j.id, action: j.action, via: j.via ?? path, error: j.error };
}

/**
 * POST a status request. `path` is explicit because the receivers differ: FRIDAY serves
 * `/api/friday/status`; the default is `/api/status`.
 */
export async function postStatus(
  baseUrl: string,
  req: StatusRequest,
  opts: { timeoutMs?: number; path?: string } = {},
): Promise<StatusResult> {
  const path = opts.path ?? "/api/status";
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const r = await postJson<StatusResult>(url, req, opts.timeoutMs ?? 8_000);
  if (!r.ok) return { ok: false, error: r.error };
  const j = r.json;
  if (!isStatusResult(j)) return { ok: false, error: "malformed status response" };
  return j;
}

const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Runtime shape check: a 2xx `{ok:true}` without the required lists must not reach consumers. */
export function isStatusResult(j: unknown): j is StatusResult {
  if (!isObj(j) || typeof j.ok !== "boolean") return false;
  if (j.ok === false) return typeof j.error === "string";
  const subject = j.subject;
  const summary = j.summary;
  return (
    typeof j.asOf === "string" &&
    typeof j.agent === "string" &&
    isObj(subject) && typeof subject.type === "string" && typeof subject.name === "string" &&
    isObj(summary) && typeof summary.status === "string" && typeof summary.health === "string" && typeof summary.headline === "string" &&
    isArr(j.recent) && isArr(j.open) && isArr(j.blocked) && isArr(j.nextUp) && isArr(j.approvalsPending) && isArr(j.sources)
  );
}

/** Capability manifest entries for the typed status route, for bus documentation/loop-cap accounting. */
export function statusCapabilities(): Record<string, { description: string; toPrompt: (args: Record<string, unknown>) => string }> {
  // The capability name selects the subject type; `type` in args is not required (and is ignored
  // when it contradicts the capability), so `client.status {name:"Acme"}` never becomes a project lookup.
  const toPrompt = (kind: "project" | "client") => (args: Record<string, unknown>) => `Status of ${kind} ${String(args.name ?? args.id ?? "")}`.trim();
  return {
    "project.status": { description: "Structured status of one project (recent work, open/blocked, next up, pending approvals, sources).", toPrompt: toPrompt("project") },
    "client.status": { description: "Structured status of one client across their projects/accounts.", toPrompt: toPrompt("client") },
  };
}
