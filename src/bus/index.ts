// Inter-agent request bus — the typed 1:1 delegation primitive (plan §2, Phase 0 PR 0.7).
//
// Generalized from CLARA's delegate_to_agent machinery, which already got the hard part right:
// distinguishing "definitely failed" from "timed out — may well have landed, don't reassign" from
// "answered but gave no receipt". That behaviour is the spec (routing.ts's 2026-08-05 incident:
// a false "nothing got queued" invites double-assignment). This module is the shared, parameterized
// version of friday-bridge.ts's fallback-chain runner + routing.ts's error classification, plus the
// two things neither had: capability manifests and loop caps (depth / cycle / identical-call).
//
// Sync request/response only. The `callback`/`resumeToken` shape reserved in the plan's request
// contract is a later, explicitly separate build (plan Phase 0 note on PR 0.7) — nothing here
// implements or depends on it.

export type BusAgent = "clara" | "friday";

// ── Outcome ────────────────────────────────────────────────────────────────────────────────────

export interface DelegateOutcome {
  ok: boolean;
  /** Which endpoint path actually served it, for caller-side logging. */
  via: string;
  reply?: string;
  taskIds?: string[];
  runId?: string;
  error?: string;
  /**
   * Timed out / connection dropped after send — genuinely unknown, NOT known-failed. Callers must
   * present this as "may still be running; re-sending could duplicate the work", never "nothing
   * happened".
   */
  indeterminate?: boolean;
  /** Set when a loop cap denied the request before any network call. */
  denied?: "depth" | "cycle";
}

/** Ids out of a `tasks`/`runs`-shaped field: strings, {id}-objects, or nothing.
 *  Single shared copy of the helper previously duplicated in CLARA's friday-bridge.ts and
 *  routing.ts. */
export function idsFrom(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : (x as { id?: unknown } | null)?.id))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Classify a caught fetch error as indeterminate (timeout/abort — the send may have landed) vs
 *  hard-failed (never reached the receiver). Ports routing.ts's classification verbatim. */
export function classifyDispatchError(e: unknown): { indeterminate: boolean; error: string } {
  const name = (e as { name?: string } | null)?.name ?? "";
  const msg = String(e);
  const timedOut = name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(msg);
  return { indeterminate: timedOut, error: msg.slice(0, 300) };
}

// ── Fallback chain ─────────────────────────────────────────────────────────────────────────────

export interface DelegateEndpoint {
  /** e.g. "/api/friday/chat" — for the outcome's `via` field. */
  path: string;
  /** Skip this endpoint for some requests (e.g. hermes/talk only serves generic/research kinds). */
  applicable?: (opts: DelegateOpts) => boolean;
  buildBody: (prompt: string, opts: DelegateOpts) => unknown;
  timeoutMs?: number;
  /** Pull a usable result out of the endpoint's JSON, or null if the body wasn't usable
   *  (fall through to the next candidate). */
  extract: (json: unknown) => { reply?: string; taskIds?: string[]; runId?: string } | null;
}

export interface DelegateOpts {
  kind?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  timeoutMs?: number;
  /** Correlation/loop-cap context — see BusContext. Optional so plain calls keep working. */
  bus?: BusContext;
  /** Extra headers (interagentAuthHeaders()) — injected by the caller so this module stays
   *  dependency-free of the interagent module's env reads in tests. */
  headers?: Record<string, string>;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Try each endpoint in priority order; first 2xx-with-usable-body wins. A candidate that throws,
 * times out, or returns an unusable body falls through to the next. Only if EVERY candidate fails
 * does the outcome go ok:false — with `indeterminate` set if any attempt timed out (the send may
 * have landed on one of them).
 */
export async function tryFallbackChain(
  baseUrl: string,
  endpoints: DelegateEndpoint[],
  prompt: string,
  opts: DelegateOpts = {},
): Promise<DelegateOutcome> {
  const base = baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  let sawTimeout = false;
  let lastError = "no endpoint produced a usable response";

  for (const ep of endpoints) {
    if (ep.applicable && !ep.applicable(opts)) continue;
    try {
      const r = await doFetch(`${base}${ep.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify(ep.buildBody(prompt, opts)),
        signal: AbortSignal.timeout(opts.timeoutMs ?? ep.timeoutMs ?? 30_000),
      });
      if (!r.ok) {
        lastError = `${ep.path} → HTTP ${r.status}`;
        continue;
      }
      const json = await r.json().catch(() => null);
      const out = json === null ? null : ep.extract(json);
      if (out) return { ok: true, via: ep.path, ...out };
      lastError = `${ep.path} → 2xx but no usable body`;
    } catch (e) {
      const c = classifyDispatchError(e);
      if (c.indeterminate) sawTimeout = true;
      lastError = `${ep.path} → ${c.error}`;
    }
  }
  return { ok: false, via: "", error: lastError, indeterminate: sawTimeout };
}

// ── Capability manifests ───────────────────────────────────────────────────────────────────────

/**
 * What an agent offers over the bus, by capability name (e.g. "calendar.find_free_slot") rather
 * than raw tool name — so FRIDAY asks for a free slot without knowing anything about CLARA's
 * Google plumbing. Registered per receiving agent; the sender resolves the capability to a
 * concrete request body via the manifest.
 */
export interface CapabilityManifest {
  agent: BusAgent;
  capabilities: Record<
    string,
    {
      description: string;
      /** Render the capability + args into the prompt the receiving agent's chat endpoint gets. */
      toPrompt: (args: Record<string, unknown>) => string;
    }
  >;
}

const registry = new Map<BusAgent, CapabilityManifest>();

export function registerManifest(manifest: CapabilityManifest): void {
  registry.set(manifest.agent, manifest);
}

export function getManifest(agent: BusAgent): CapabilityManifest | undefined {
  return registry.get(agent);
}

export function listCapabilities(agent: BusAgent): string[] {
  return Object.keys(registry.get(agent)?.capabilities ?? {});
}

// ── Loop caps (plan §7.1 — accepted defaults) ─────────────────────────────────────────────────

export interface BusCaps {
  maxDepth: number;
  maxToolCallsPerRun: number;
  maxIdenticalCalls: number;
}

export const DEFAULT_CAPS: BusCaps = {
  maxDepth: 3,
  maxToolCallsPerRun: 40,
  maxIdenticalCalls: 3,
};

/**
 * Correlation context threaded through a chain of bus requests. The ORIGINATING call mints one;
 * every hop passes it along (serialized into the request, rehydrated by the receiver) so depth and
 * cycles are judged against the whole chain, not one hop.
 */
export interface BusContext {
  correlationId: string;
  /** Hops so far: "<agent>:<capability>" per hop, in order. */
  chain: string[];
  caps?: Partial<BusCaps>;
}

export function newBusContext(caps?: Partial<BusCaps>): BusContext {
  return { correlationId: crypto.randomUUID(), chain: [], caps };
}

/**
 * Gate a prospective hop BEFORE any network call. Deny on depth breach or on a cycle (the same
 * agent asked for the same capability earlier in this chain — the signature of CLARA → FRIDAY →
 * CLARA ping-pong). Returns the extended context on allow.
 */
export function checkHop(
  ctx: BusContext,
  to: BusAgent,
  capability: string,
): { allowed: true; next: BusContext } | { allowed: false; denied: "depth" | "cycle"; detail: string } {
  const caps = { ...DEFAULT_CAPS, ...ctx.caps };
  const hop = `${to}:${capability}`;
  if (ctx.chain.includes(hop)) {
    return { allowed: false, denied: "cycle", detail: `chain ${[...ctx.chain, hop].join(" → ")} revisits ${hop}` };
  }
  if (ctx.chain.length >= caps.maxDepth) {
    return { allowed: false, denied: "depth", detail: `depth ${ctx.chain.length} at cap ${caps.maxDepth}: ${ctx.chain.join(" → ")}` };
  }
  return { allowed: true, next: { ...ctx, chain: [...ctx.chain, hop] } };
}

/**
 * Per-run identical-call guard (plan §7.1: same tool + same args 3× in one run is the signature of
 * a stuck loop). One instance per run, fed every tool call; `check` returns false when the run
 * should halt.
 */
export class IdenticalCallGuard {
  private counts = new Map<string, number>();
  private total = 0;
  private caps: BusCaps;
  // No parameter property — the repo's test runner uses Node's strip-only TS mode, which rejects them.
  constructor(caps: BusCaps = DEFAULT_CAPS) {
    this.caps = caps;
  }

  check(toolName: string, args: unknown): { ok: boolean; reason?: string } {
    this.total++;
    if (this.total > this.caps.maxToolCallsPerRun) {
      return { ok: false, reason: `tool-call cap (${this.caps.maxToolCallsPerRun}/run) reached` };
    }
    const key = `${toolName}:${JSON.stringify(args) ?? ""}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n >= this.caps.maxIdenticalCalls) {
      return { ok: false, reason: `identical call ${toolName} repeated ${n}× — stuck-loop signature` };
    }
    return { ok: true };
  }
}
