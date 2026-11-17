// Principals — the humans the agents work FOR (G1).
//
// Until now every agent assumed exactly one owner (see ./owner.ts). When a second principal
// joins, inbound channel identity (SMS/voice/email) must resolve to WHICH principal is
// talking, and downstream OS access must scope to that principal's partition (M0
// contact-rooted RLS; agents are partition-exempt so the scoping happens at the tool
// layer — see osmcp's principal scoping).
//
// Config: ~/.agentic-os/principals.json (shared by all agents on the box), overridable via
// ORION_PRINCIPALS (path to a JSON file). No fallback list is compiled in — a missing file
// means only the owner-profile's single owner is recognized (yesterday's behavior), so
// nothing breaks on boxes without the file.
//
// Matching rules: emails exact (case-insensitive); phones by last-10-digits (US-centric,
// tolerant of formatting differences like "555 0100100" vs "+1 (555) 010-0100").

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getOwnerProfile } from "./owner";

export interface Principal {
  /** Stable short key, e.g. "jordan". */
  key: string;
  /** The principal's OS (Supabase) user id — owner_id for records in their partition. */
  osUserId: string;
  name: string;
  firstName?: string;
  emails: string[];
  phones: string[];
  /** Exactly one principal is primary — the default when context gives no signal
   *  (existing single-owner flows keep behaving exactly as before). */
  primary?: boolean;
}

const FILE = process.env["ORION_PRINCIPALS"]
  ?? path.join(os.homedir(), ".agentic-os", "principals.json");

let cache: { at: number; list: Principal[] } | null = null;
const TTL = 5 * 60_000;

function last10(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export function getPrincipals(): Principal[] {
  if (cache && Date.now() - cache.at < TTL) return cache.list;
  let list: Principal[] = [];
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as { principals?: Principal[] };
    if (Array.isArray(raw.principals)) list = raw.principals.filter((p) => p.key && p.osUserId);
  } catch { /* no file → single-owner fallback below */ }
  if (list.length === 0) {
    const o = getOwnerProfile();
    list = [{
      key: "owner",
      osUserId: "",
      name: o.identity.name,
      firstName: o.identity.firstName,
      emails: [o.identity.workEmail].filter(Boolean),
      phones: o.identity.phone ? [o.identity.phone] : [],
      primary: true,
    }];
  }
  cache = { at: Date.now(), list };
  return list;
}

export function getPrimaryPrincipal(): Principal {
  const list = getPrincipals();
  return list.find((p) => p.primary) ?? list[0];
}

export function getPrincipal(key: string): Principal | null {
  return getPrincipals().find((p) => p.key === key) ?? null;
}

export function resolvePrincipalByPhone(phone: string | null | undefined): Principal | null {
  if (!phone) return null;
  const digits = last10(phone);
  if (digits.length < 10) return null;
  return getPrincipals().find((p) => p.phones.some((x) => last10(x) === digits)) ?? null;
}

export function resolvePrincipalByEmail(email: string | null | undefined): Principal | null {
  if (!email) return null;
  const norm = email.trim().toLowerCase();
  return getPrincipals().find((p) => p.emails.some((x) => x.trim().toLowerCase() === norm)) ?? null;
}

/** Convenience: is this phone/email ANY principal (owner-tier)? */
export function resolvePrincipal(opts: { phone?: string | null; email?: string | null }): Principal | null {
  return resolvePrincipalByPhone(opts.phone) ?? resolvePrincipalByEmail(opts.email);
}
