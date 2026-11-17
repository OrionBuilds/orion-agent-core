// M1 — OS-contacts sync engine (used by FRIDAY).
//
// Since M1, the agents' clients LIVE in OS contacts; each app's local clients.json is a
// write-through mirror kept fresh by this module, so every existing `store.clients.*` call
// site (and the zero-latency inbound SMS/email matching) keeps working unchanged.
//
// Ownership of fields is split:
//   * contact-native fields (name/company/email/phone/address/status) — the OS wins; pulled
//     down on every refresh.
//   * agent-private fields (authority profiles, bypass policies, drive folders, feedback
//     stamps, zernio ids, …: everything NOT in NATIVE_KEYS) — the LOCAL row wins; pushed up
//     into contact_agent_meta.meta on refresh when drifted. Only this agent ever writes its
//     own meta rows, so local-wins is safe, and the ~15 pre-M1 call sites that write these
//     fields via store.clients.update() directly keep working without modification.
//
// Identity: a mirrored row keeps the agent's LEGACY local client id when the OS row was
// migrated from this app (contact_agent_meta.local_client_id), so projects/tasks/docs that
// reference old client ids stay valid. Rows born in the OS use the contact UUID as their id.
// Every mirrored row carries `osContactId` for the reverse mapping.
//
// The refresh also reconciles stragglers: a local row with no OS mapping (created while the
// OS was unreachable) is pushed up as a new contact + meta row on the next refresh.

import type { Collection, Entity } from "../store";
import type { OsMcpClient } from "./index";

type Row = Entity & Record<string, unknown>;

export interface OsContactRow {
  id: string;
  owner_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  job_title?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  status?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AgentMetaRow {
  id: string;
  contact_id: string;
  agent: string;
  local_client_id: string | null;
  meta: Record<string, unknown>;
  contact?: OsContactRow | null;
}

export interface ContactsSyncConfig {
  agent: "friday";
  client: OsMcpClient;
  enabled: () => boolean;
  collection: Collection<Row>;
  /** Refresh no more often than this (default 5 min). */
  ttlMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Local-row keys owned by the OS contact (everything else is agent-private → meta). */
const NATIVE_KEYS = new Set([
  "id", "osContactId", "osOwnerUserId", "name", "company", "email", "phone", "jobTitle",
  "addressLine", "city", "state", "postalCode", "status", "createdAt", "updatedAt",
]);

/** meta.meta bookkeeping keys that are not agent-private row fields. */
const META_BOOKKEEPING = new Set(["localStatus", "archived"]);

// OS contacts take only `active` or `archived` (contacts_status_check; contacts_create rejects anything
// else). The old mapping sent past → "inactive" and prospect → "lead": every push of a past client failed,
// and the reconcile retried it on every refresh (two past clients, ~4,700 errors since
// 2026-11-03). The agent's own status always survives in meta.localStatus.
export function osStatusToLocal(os: string | null | undefined): string {
  switch ((os ?? "").toLowerCase()) {
    case "archived": case "inactive": return "past";
    case "lead": case "prospect": return "prospect";
    case "paused": return "paused";
    default: return "active";
  }
}

export function localStatusToOs(local: string | null | undefined): "active" | "archived" {
  switch ((local ?? "").toLowerCase()) {
    case "past": return "archived";
    default: return "active"; // prospect and paused have no OS equivalent — meta.localStatus preserves them
  }
}

/** After a failed push of a local client, wait this long before trying it again. */
export const PUSH_RETRY_AFTER_MS = 6 * 60 * 60_000;

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

function splitName(name: string): { first: string; last: string } {
  const trimmed = (name ?? "").trim();
  const space = trimmed.indexOf(" ");
  if (space === -1) return { first: trimmed, last: "" };
  return { first: trimmed.slice(0, space), last: trimmed.slice(space + 1) };
}

function privateFieldsOf(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!NATIVE_KEYS.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

function metaPrivateOf(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (!META_BOOKKEEPING.has(k)) out[k] = v;
  }
  return out;
}

function stable(v: unknown): string {
  // JSON.stringify with an ARRAY replacer is a key allow-list applied at every
  // nesting level, not a sort order — nested keys vanished, so
  // { authority: { tier: 1 } } and { tier: 3 } serialized identically and drift
  // in agent-private nested objects (authority profiles, bypass policies) was
  // never detected or pushed. Sort keys recursively instead.
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const src = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = norm(src[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

export class ContactsSync {
  private cfg: ContactsSyncConfig;
  private lastRefreshAt = 0;
  private inflight: Promise<void> | null = null;
  /** Local client id → when a failed push may be tried again (a bad row must not fail every refresh). */
  private pushRetryAt = new Map<string, number>();

  constructor(cfg: ContactsSyncConfig) {
    this.cfg = cfg;
  }

  private log(event: string, data: Record<string, unknown>): void {
    try { this.cfg.log?.(event, data); } catch { /* logging must never break sync */ }
  }

  /** TTL-gated, single-flight, never throws. Call from schedulers or lazily before reads. */
  async refresh(force = false): Promise<void> {
    if (!this.cfg.enabled()) return;
    const ttl = this.cfg.ttlMs ?? 5 * 60_000;
    if (!force && Date.now() - this.lastRefreshAt < ttl) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh()
      .catch((e) => this.log("contacts.sync.error", { error: String(e).slice(0, 200) }))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const metas = unwrap(
      await this.cfg.client.callTool("contact_agent_meta_get", { agent: this.cfg.agent }),
    ) as AgentMetaRow[];
    if (!Array.isArray(metas)) return;

    const local = (await this.cfg.collection.all()) as Row[];
    const localById = new Map(local.map((r) => [r.id, r]));
    const mappedLocalIds = new Set<string>();
    const target: Row[] = [];

    for (const m of metas) {
      const c = m.contact;
      if (!c) continue;
      const localId = m.local_client_id ?? c.id;
      mappedLocalIds.add(localId);

      if (m.meta?.["archived"]) {
        if (localById.has(localId)) {
          await this.cfg.collection.remove(localId).catch(() => {});
          this.log("contacts.sync.removed", { id: localId });
        }
        continue;
      }

      const existing = localById.get(localId);
      let meta = m.meta ?? {};

      // Up-sync: agent-private fields on the local row win over stale meta.
      if (existing) {
        const localPrivate = privateFieldsOf(existing);
        const metaPrivate = metaPrivateOf(meta);
        const localStatus = String(existing["status"] ?? "");
        const statusDrift = localStatus && localStatus !== (meta["localStatus"] ?? osStatusToLocal(c.status));
        if (stable(localPrivate) !== stable(metaPrivate) || statusDrift) {
          meta = { ...meta, ...localPrivate, localStatus: localStatus || meta["localStatus"] };
          void this.cfg.client
            .callTool("contact_agent_meta_set", { contact_id: c.id, agent: this.cfg.agent, meta })
            .catch((e) => this.log("contacts.sync.metapush.error", { id: localId, error: String(e).slice(0, 160) }));
          if (statusDrift) {
            void this.cfg.client
              .callTool("contacts_update", { id: c.id, status: localStatusToOs(localStatus) })
              .catch(() => {});
          }
        }
      }

      const row: Row = {
        ...metaPrivateOf(meta),
        id: localId,
        osContactId: c.id,
        osOwnerUserId: c.owner_id ?? undefined,
        name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || (c.company ?? "Unknown"),
        company: c.company ?? undefined,
        email: c.email ?? undefined,
        phone: c.phone ?? undefined,
        jobTitle: c.job_title ?? undefined,
        addressLine: c.address_line1 ?? undefined,
        city: c.city ?? undefined,
        state: c.state ?? undefined,
        postalCode: c.postal_code ?? undefined,
        status: (existing?.["status"] as string) ?? (meta["localStatus"] as string) ?? osStatusToLocal(c.status),
        createdAt: (existing?.["createdAt"] as string) ?? c.created_at ?? new Date().toISOString(),
        updatedAt: c.updated_at ?? new Date().toISOString(),
      };
      target.push(row);
    }

    if (target.length > 0) {
      await this.cfg.collection.upsertMany(target, false);
    }

    // Reconcile stragglers: local rows never mapped to an OS contact get pushed up.
    for (const r of local) {
      if (mappedLocalIds.has(r.id)) continue;
      if (r["osContactId"]) continue; // mapped previously; its meta row will return next refresh
      if ((this.pushRetryAt.get(r.id) ?? 0) > Date.now()) continue;
      await this.pushCreate(r).then(() => { this.pushRetryAt.delete(r.id); }).catch((e) => {
        this.pushRetryAt.set(r.id, Date.now() + PUSH_RETRY_AFTER_MS);
        this.log("contacts.sync.pushcreate.error", { id: r.id, error: String(e).slice(0, 300), retryInHours: PUSH_RETRY_AFTER_MS / 3_600_000 });
      });
    }

    this.lastRefreshAt = Date.now();
    this.log("contacts.sync.ok", { count: target.length });
  }

  /** Push a locally-created client up to the OS (best-effort; call after local insert). */
  async pushCreate(row: Row): Promise<string | null> {
    if (!this.cfg.enabled()) return null;
    const { first, last } = splitName(String(row["name"] ?? ""));
    const created = unwrap(await this.cfg.client.callTool("contacts_create", {
      first_name: first,
      last_name: last,
      email: (row["email"] as string) || undefined,
      phone: (row["phone"] as string) || undefined,
      company: (row["company"] as string) || undefined,
      status: localStatusToOs(row["status"] as string),
      source: `${this.cfg.agent}-app`,
    })) as Array<{ id: string }> | { id: string };
    const osId = Array.isArray(created) ? created[0]?.id : created?.id;
    if (!osId) return null;
    await this.cfg.client.callTool("contact_agent_meta_set", {
      contact_id: osId,
      agent: this.cfg.agent,
      local_client_id: row.id,
      meta: { ...privateFieldsOf(row), localStatus: row["status"] },
    });
    await this.cfg.collection.update(row.id, { osContactId: osId } as Partial<Row>).catch(() => {});
    this.log("contacts.sync.created", { id: row.id, osContactId: osId });
    return osId;
  }

  /** Push a local update up to the OS (best-effort; call after local update). */
  async pushUpdate(row: Row, patch: Record<string, unknown>): Promise<void> {
    if (!this.cfg.enabled()) return;
    const osId = row["osContactId"] as string | undefined;
    if (!osId) return; // refresh() reconciles unmapped rows later
    const native: Record<string, unknown> = {};
    if (patch["name"] !== undefined) {
      const { first, last } = splitName(String(patch["name"]));
      native["first_name"] = first;
      native["last_name"] = last;
    }
    if (patch["company"] !== undefined) native["company"] = patch["company"];
    if (patch["email"] !== undefined) native["email"] = patch["email"];
    if (patch["phone"] !== undefined) native["phone"] = patch["phone"];
    if (patch["jobTitle"] !== undefined) native["job_title"] = patch["jobTitle"];
    if (patch["addressLine"] !== undefined) native["address_line1"] = patch["addressLine"];
    if (patch["city"] !== undefined) native["city"] = patch["city"];
    if (patch["state"] !== undefined) native["state"] = patch["state"];
    if (patch["postalCode"] !== undefined) native["postal_code"] = patch["postalCode"];
    if (patch["status"] !== undefined) native["status"] = localStatusToOs(patch["status"] as string);
    if (Object.keys(native).length > 0) {
      await this.cfg.client.callTool("contacts_update", { id: osId, ...native });
    }
    const priv: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!NATIVE_KEYS.has(k)) priv[k] = v;
    }
    if (patch["status"] !== undefined) priv["localStatus"] = patch["status"];
    if (Object.keys(priv).length > 0) {
      await this.cfg.client.callTool("contact_agent_meta_set", {
        contact_id: osId, agent: this.cfg.agent, meta: priv,
      });
    }
  }

  /** Mark a client archived for this agent (local delete already done by the caller).
   *  The OS contact itself is untouched — it may be shared with other agents/the CRM. */
  async pushArchive(row: Row): Promise<void> {
    if (!this.cfg.enabled()) return;
    const osId = row["osContactId"] as string | undefined;
    if (!osId) return;
    await this.cfg.client.callTool("contact_agent_meta_set", {
      contact_id: osId, agent: this.cfg.agent, meta: { archived: true },
    });
  }
}
