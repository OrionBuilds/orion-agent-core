// OwnerProfile — owner-specific values loaded from env/local file, never committed
// (plan §3.2, Phase 0 PR 0.10). Exists so nothing that identifies the owner or a client has to
// live in a .ts file under version control: the earlier arrangement (the owner's personal email
// excluded *by name* in clara's google-auth.ts, home coordinates in clara's config.ts, real Drive
// ids as source-level defaults) is exactly what a course screen-share must never show, and it also
// means a policy change requires a code edit.
//
// Resolution order: ORION_OWNER_PROFILE env var (path to a JSON file, or a directory containing
// owner-profile.json) → ~/.agentic-os/owner-profile.json → the clearly-fake DEFAULT_OWNER_PROFILE.
//
// Two loaders:
//   - getOwnerProfile()  — synchronous, cached, never returns null (falls back to the fake
//     default). This is what agent source uses for module-level constants (persona prompts,
//     excluded-account checks) so behaviour with a real profile on disk is byte-identical to the
//     old hardcoded literals.
//   - loadOwnerProfile() — the original async loader; returns null when none is configured, for
//     callers that need to distinguish "no profile" from "default profile".

import { promises as fs } from "node:fs";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface OwnerProfile {
  identity: {
    /** Full display name, e.g. "Alex Operator". */
    name: string;
    /** First name for informal address; derived from `name` when absent. */
    firstName?: string;
    workEmail: string;
    /** Personal accounts no agent may ever touch — enforced at the credential layer, listed here
     *  so the exclusion is config, not a hardcoded string in an agent's source. */
    excludedAccounts: string[];
    phone?: string;
  };
  location?: {
    homeLat?: number;
    homeLng?: number;
    timezone?: string;
  };
  /** The owner's own business identity (used in agent personas + outbound copy). */
  business?: {
    name?: string;
    domain?: string;
    infoEmail?: string;
  };
  /** Google Shared Drive ids — previously hardcoded source-level defaults in each agent. */
  drives?: {
    claraDriveId?: string;
    fridayDriveId?: string;
  };
  vault?: {
    /** Absolute path to the Obsidian office vault. */
    path?: string;
  };
  boundaries: {
    /** Which agent exclusively owns the owner's personal mail/contacts/calendar. */
    personalMailOwner: "clara" | "friday";
  };
}

/** Clearly-fake placeholder profile — what a fresh clone (a course student) runs on until they
 *  write their own owner-profile.json. Nothing in here identifies a real person or client. */
export const DEFAULT_OWNER_PROFILE: OwnerProfile = {
  identity: {
    name: "Alex Operator",
    firstName: "Alex",
    workEmail: "alex@example.com",
    excludedAccounts: ["alex.personal@example.com"],
    phone: "+15550100000",
  },
  location: { timezone: "America/New_York" },
  business: { name: "Example Lab", domain: "example.com", infoEmail: "info@example.com" },
  drives: {},
  vault: {},
  boundaries: { personalMailOwner: "clara" },
};

const DEFAULT_DIR = path.join(os.homedir(), ".agentic-os");
const PROFILE_BASENAME = "owner-profile.json";

/** ORION_OWNER_PROFILE may point at the JSON file itself or at a directory containing it. */
function resolveEnvPath(p: string): string {
  try {
    if (statSync(p).isDirectory()) return path.join(p, PROFILE_BASENAME);
  } catch {
    /* not stat-able — treat as a file path and let the read fail naturally */
  }
  return p;
}

function candidatePaths(): string[] {
  const env = process.env.ORION_OWNER_PROFILE?.trim();
  return [env ? resolveEnvPath(env) : undefined, path.join(DEFAULT_DIR, PROFILE_BASENAME)]
    .filter((p): p is string => Boolean(p));
}

/** Section-wise merge: a real profile only has to carry the fields it wants to override; anything
 *  absent falls back to the fake default so agent code never reads `undefined` where the default
 *  has a value. */
function mergeOverDefault(parsed: Partial<OwnerProfile>): OwnerProfile {
  const d = DEFAULT_OWNER_PROFILE;
  // A parsed identity replaces the fake one OUTRIGHT — no field-wise merge. Letting the default's
  // identifying fields ride along is actively dangerous: the fake excludedAccounts would mark a
  // made-up address as the owner's protected personal account (and leave the real one unprotected),
  // and the fake phone would let a caller from +15550100000 resolve as the owner via principals.ts.
  const identity: OwnerProfile["identity"] = parsed.identity
    ? {
        ...parsed.identity,
        firstName: parsed.identity.firstName
          ?? parsed.identity.name?.trim().split(/\s+/)[0],
        excludedAccounts: parsed.identity.excludedAccounts ?? [],
      }
    : { ...d.identity };
  return {
    identity,
    location: { ...d.location, ...(parsed.location ?? {}) },
    business: { ...d.business, ...(parsed.business ?? {}) },
    drives: { ...d.drives, ...(parsed.drives ?? {}) },
    vault: { ...d.vault, ...(parsed.vault ?? {}) },
    boundaries: { ...d.boundaries, ...(parsed.boundaries ?? {}) },
  };
}

let cached: OwnerProfile | null | undefined;
let syncCached: OwnerProfile | undefined;

/** Synchronous loader — never null. Missing file → DEFAULT_OWNER_PROFILE; a malformed file throws
 *  loudly (a half-applied profile silently mixing real and fake identity would be worse). */
export function getOwnerProfile(): OwnerProfile {
  if (syncCached) return syncCached;
  for (const file of candidatePaths()) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    syncCached = mergeOverDefault(JSON.parse(raw) as Partial<OwnerProfile>);
    return syncCached;
  }
  syncCached = DEFAULT_OWNER_PROFILE;
  return syncCached;
}

/** First name for informal address — explicit field first, else the first token of the name. */
export function ownerFirstName(p: OwnerProfile = getOwnerProfile()): string {
  return p.identity.firstName?.trim() || p.identity.name.trim().split(/\s+/)[0] || "Owner";
}

/** Primary excluded personal account (lowercased) — the address the personal-mail boundary names. */
export function ownerPersonalEmail(p: OwnerProfile = getOwnerProfile()): string {
  return (p.identity.excludedAccounts[0] ?? "").toLowerCase();
}

/** Load (and cache) the owner profile. Returns null when none is configured. */
export async function loadOwnerProfile(opts?: { reload?: boolean }): Promise<OwnerProfile | null> {
  if (cached !== undefined && !opts?.reload) return cached;
  for (const file of candidatePaths()) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as OwnerProfile;
      if (!parsed?.identity?.workEmail || !parsed?.boundaries?.personalMailOwner) {
        throw new Error(`owner profile at ${file} is missing required fields (identity.workEmail, boundaries.personalMailOwner)`);
      }
      cached = mergeOverDefault(parsed);
      return cached;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e; // a malformed profile should fail loudly, not silently fall through
    }
  }
  cached = null;
  return null;
}

/** Test seam / hot-reload hook. */
export function clearOwnerProfileCache(): void {
  cached = undefined;
  syncCached = undefined;
}
