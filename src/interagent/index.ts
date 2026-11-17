// Shared inter-agent delegation contract for FRIDAY/CLARA — formalizes what was
// previously an unauthenticated, contract-drifted, ad hoc HTTP call (CLARA's friday-bridge.ts)
// or a slow one-way file drop with no confirmation (a Drive handoff). The apps
// stay otherwise isolated (separate repos, separate deploys, separate data stores) — this module
// is just the shared vocabulary + auth for the handful of calls that cross between them.

import { timingSafeEqual } from "node:crypto";

export type InteragentCaller = "friday" | "clara";

export type InteragentKind = "chat" | "draft" | "code" | "seo" | "research" | "handoff" | "escalate" | "status";

// ── Escalation (FRIDAY → CLARA) ──────────────────────────────────────────────
// FRIDAY may not text or call the owner (owner rule 2026-09-24). A genuine
// emergency is handed to CLARA, who decides whether the owner is interrupted. See
// `postEscalation` in ./escalate.ts.

export type EscalationCategory = "production" | "security" | "revenue";

export interface EscalationRequest {
  from: "friday";
  kind: "escalate";
  category: EscalationCategory;
  /** ≤120 chars, plain English, no emoji, no approval codes. */
  headline: string;
  /** ≤2000 chars: what was checked, since when, impact. */
  detail: string;
  links: Array<{ label: string; url: string }>;
  /** e.g. "friday:uptime.down:<projectId>:<day>" — CLARA dedupes on it. */
  dedupeKey: string;
  occurredAt: string; // ISO
  source: { app: "friday"; kind: string; refId?: string };
  suggestedAction?: string;
  needsDecision?: { question: string; options: string[] };
  clientName?: string;
}

export interface EscalationResponse {
  ok: boolean;
  id?: string;
  action?: "called" | "texted" | "emailed" | "queued" | "deduped";
  via: string;
  error?: string;
}

// ── Status (any agent → FRIDAY) ──────────────────────────────────────────────
// A structured, provenance-carrying answer to "how is project X going?" — so CLARA can answer
// the owner without free-texting another agent's chat endpoint (which may create a task).

export interface StatusSubject { type: "project" | "client" | "task" | "portfolio"; id?: string; name?: string }

export interface StatusRequest { from: InteragentCaller; kind: "status"; subject: StatusSubject; since?: string }

export interface StatusItem {
  when: string;
  headline: string;
  detail?: string;
  link?: string;
  source: "portal" | "git" | "deploy" | "run" | "log" | "task" | "approval" | "ads" | "alert";
}

export interface StatusResponse {
  ok: true;
  asOf: string;
  agent: InteragentCaller;
  subject: { type: StatusSubject["type"]; id: string; name: string; client?: string };
  summary: { stage?: string; status: string; health: "green" | "amber" | "red" | "unknown"; headline: string };
  recent: StatusItem[];
  open: StatusItem[];
  blocked: StatusItem[];
  nextUp: StatusItem[];
  approvalsPending: StatusItem[];
  sources: { name: string; fetchedAt: string; ok: boolean; note?: string }[];
}

export type StatusResult = StatusResponse | { ok: false; error: string; candidates?: { id: string; name: string; client?: string }[] };

export interface InteragentRequest {
  from: InteragentCaller;
  kind: InteragentKind;
  /** Free-text ask (chat/draft/code/seo/research kinds). */
  prompt?: string;
  /** Drive file id being handed off (handoff kind) — lets the receiver process just that file
   *  instead of re-scanning a whole folder. */
  driveFileId?: string;
  /** Receiver-side client id, when the caller already knows which client this concerns. */
  clientId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface InteragentResponse {
  ok: boolean;
  /** Which endpoint/path actually served the request, for caller-side logging. */
  via: string;
  reply?: string;
  /** Id of a tracked task/run the receiver created for this request, if any (e.g. FRIDAY minting
   *  a Task from a handoff) — the caller's confirmation-of-receipt. */
  taskId?: string;
  error?: string;
}

const HEADER = "x-interagent-secret";

/**
 * Marker header that an app's perimeter host-gate middleware sets AFTER it has cryptographically
 * verified a Cloudflare Access assertion (signature + `aud` + `iss` against the team JWKS). It is
 * the ONLY trustworthy signal that a request was Access-authenticated at the edge.
 *
 * SECURITY CONTRACT — the middleware that sets this MUST, on EVERY request:
 *   1. delete/strip any client-supplied copy of this header, and
 *   2. set it (to "1") ONLY after the Cf-Access-Jwt-Assertion JWT verifies.
 *
 * This module deliberately does NOT read the raw `Cf-Access-Jwt-Assertion` header: its mere
 * presence is forgeable by any caller, which was exactly the pre-2026-09 bypass. Trust flows only
 * through this middleware-controlled marker. (JWKS verification lives at the perimeter, not here,
 * so this shared check stays synchronous — no `await` in the ~20 route handlers that call it.)
 */
export const ACCESS_VERIFIED_HEADER = "x-agent-access-verified";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Strips the port and any IPv6 brackets, then tests against the loopback set. */
function isLoopbackHost(raw: string | null): boolean {
  if (!raw) return false;
  const host = raw.trim().toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * True when a request already proved its identity through a boundary STRONGER than the shared
 * secret, so an owner/human request should not additionally need a static string meant for
 * sibling agents:
 *
 *   - It never left the machine: Host (and X-Forwarded-Host, if present) are both loopback. All
 *     agents bind 127.0.0.1, so a request with Host=127.0.0.1 cannot have arrived from
 *     outside. Requiring BOTH headers loopback-or-absent is the fail-closed direction (a proxy may
 *     preserve Host while signalling the real origin via X-Forwarded-Host).
 *   - Cloudflare Access authenticated a real human at the edge AND the app's perimeter middleware
 *     cryptographically verified that assertion and stamped `ACCESS_VERIFIED_HEADER` (see its
 *     contract above). We trust that middleware-set marker — never the raw, forgeable
 *     `Cf-Access-Jwt-Assertion` header, whose mere presence was the pre-2026-09 bypass.
 */
function isAlreadyTrusted(req: Request): boolean {
  const host = req.headers.get("host");
  const forwarded = req.headers.get("x-forwarded-host");
  if (isLoopbackHost(host) && (forwarded === null || isLoopbackHost(forwarded))) return true;
  return req.headers.get(ACCESS_VERIFIED_HEADER) === "1";
}

/** Header to attach on an outbound inter-agent call. Omits the header (rather than sending an
 *  empty one) when no shared secret is configured, so local dev without INTERAGENT_SHARED_SECRET
 *  set still works — the receiver's own check treats a missing configured secret as "auth off". */
export function interagentAuthHeaders(): Record<string, string> {
  const secret = process.env.INTERAGENT_SHARED_SECRET?.trim();
  return secret ? { [HEADER]: secret } : {};
}

/**
 * Verify an inbound inter-agent call. Returns true when any of:
 *   (a) no INTERAGENT_SHARED_SECRET is configured on this receiver (auth intentionally off — e.g.
 *       local dev),
 *   (b) the request's header matches the configured secret, or
 *   (c) the request already cleared a stronger boundary — loopback, or Access-verified at the
 *       perimeter (see `isAlreadyTrusted`).
 *
 * (c) exists because of a real incident: on 2026-08-04, FRIDAY's own web chat returned 401 on
 * every message once INTERAGENT_SHARED_SECRET was configured, because her browser's own fetch
 * call never attaches this header — the route comments that assumed "auth is a no-op ... so
 * FRIDAY's own web UI is unaffected" were only true while the secret happened to be unset. A
 * caller that already proved it is the owner (loopback, or Access) should not additionally need a
 * static string meant for OTHER AGENTS. Crucially, the Access half of (c) now trusts only the
 * middleware-verified `ACCESS_VERIFIED_HEADER` marker — not the raw, forgeable
 * `Cf-Access-Jwt-Assertion` header, which previously let any caller bearing that header name bypass
 * this check.
 *
 * Does NOT verify against a specific `from` claim — the header alone identifies "this came from
 * one of my sibling agents," which is the actual trust boundary for genuine cross-agent calls
 * (all bind to 127.0.0.1); the `from` field in the body is caller-attribution for logging,
 * not an identity check.
 */
export function verifyInteragentSecret(req: Request): boolean {
  const secret = process.env.INTERAGENT_SHARED_SECRET?.trim();
  if (!secret) return true;
  const presented = req.headers.get(HEADER);
  if (presented !== null && constantTimeEquals(presented, secret)) return true;
  return isAlreadyTrusted(req);
}

// A plain === comparison short-circuits on the first differing byte, letting an attacker recover
// the secret prefix-by-prefix from response timing. timingSafeEqual needs equal-length buffers, so
// a length mismatch is an immediate (and unavoidable — length leaks anyway) false.
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
