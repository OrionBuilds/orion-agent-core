// Shared, provider-neutral HTTP clients for the prospecting engine (plan 2026-09-30, PR 4a).
//
// Contract: a client takes the API key as an ARGUMENT, never reads env, never caches, never bills.
// Caching, cost ledgers, budgets and gating live in the calling app (CLARA's `prospecting/`), so
// the same client can be reused by FRIDAY without inheriting CLARA's policy. Tests inject
// `fetchImpl` and feed recorded fixtures — no client here ever hits the network in a test.

export interface ProviderCallOpts {
  /** The provider credential. Empty string ⇒ the call is refused before any request is made. */
  key: string;
  /** Injectable for tests and for callers that wrap fetch (proxies, recorders). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Per-call timeout; each client has its own default. */
  timeoutMs?: number;
}

export interface ProviderOk<T> {
  ok: true;
  data: T;
  /** The parsed response body, untouched — for evidence storage and for callers that need a field
   *  the normalized `data` doesn't carry. */
  raw: unknown;
  /** Provider-native cost units for this call (requests, credits, …). The caller converts to USD. */
  costUnits: number;
  status: number;
}

export interface ProviderErr {
  ok: false;
  error: string;
  status?: number;
  /** 429 (quota / rate limit) or 402 (out of credits): the caller should open its circuit breaker
   *  and reschedule instead of counting an attempt. */
  rateLimited?: boolean;
  raw?: unknown;
  costUnits: 0;
}

export type ProviderResult<T> = ProviderOk<T> | ProviderErr;

export interface ProviderClient<Req, Res> {
  /** Stable id used by the caller's ledger/cache keys (e.g. "places", "leadmagic"). */
  provider: string;
  call(req: Req, opts: ProviderCallOpts): Promise<ProviderResult<Res>>;
}

/**
 * One fetch with timeout, status classification and JSON parsing, shared by every client.
 * Returns the parsed body on 2xx; on 429/402 flags `rateLimited`; never throws.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  opts: ProviderCallOpts,
  defaultTimeoutMs: number,
): Promise<{ ok: true; json: unknown; status: number } | ProviderErr> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // A caller that already cancelled must not cause a billed request ("abort" never fires for a
  // signal that is aborted before the listener is attached).
  if (opts.signal?.aborted) return { ok: false, error: "aborted by caller", costUnits: 0 };
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs ?? defaultTimeoutMs);
  const onOuterAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const r = await fetchImpl(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!r.ok) {
      const rateLimited = r.status === 429 || r.status === 402;
      return {
        ok: false, status: r.status, rateLimited, raw: json ?? text.slice(0, 500), costUnits: 0,
        error: `HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, json, status: r.status };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? "";
    const msg = name === "AbortError"
      ? (timedOut ? `timeout after ${opts.timeoutMs ?? defaultTimeoutMs}ms` : "aborted by caller")
      : String((e as Error)?.message ?? e);
    return { ok: false, error: msg, costUnits: 0 };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Every client refuses an empty key the same way, before touching the network. */
export function missingKey(provider: string): ProviderErr {
  return { ok: false, error: `${provider}: no API key given`, costUnits: 0 };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const asObj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
export const asStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
