// Shared Orion authentication — structurally ported from CLARA's
// google-auth.ts token-cache pattern (file-backed refresh token, in-memory access-token cache
// with a 60s pre-expiry margin), generalized into a factory since each app needs its own config
// (agent directory, redirect URI) rather than CLARA's single-app global-singleton shape.
//
// Auth flow: Supabase's own `/auth/v1/authorize?provider=google` hands the OAuth dance to
// Supabase + Google, then redirects back with the session in a URL FRAGMENT (fragments never
// reach the server) — so the actual token capture happens client-side on a small "capture" page
// that POSTs the tokens to this module's callback handler. See each app's
// src/app/api/os/auth/{route.ts,callback/route.ts} + src/app/os/auth/capture/page.tsx.
//
// Refresh tokens ROTATE on every use (unlike Google's) — the new one from each refresh response
// MUST be persisted, or the next refresh fails. A single in-flight refresh promise is shared by
// concurrent callers so two near-simultaneous refreshes can't race each other into invalidating
// the token the other is about to use.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

export interface OsAuthConfig {
  /** Directory this agent's session file lives in, e.g. ~/.agentic-os/friday */
  agentDir: string;
  /** The OS Supabase project. Falls back to env ORION_SUPABASE_URL / ORION_SUPABASE_ANON_KEY.
   *  There is deliberately NO built-in default (Orion is sold as a product — a buyer's agent must
   *  never silently talk to someone else's project); unset ⇒ osConfigured() is false and every
   *  token call fails with a clear "not configured" error. */
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  /** This app's own capture-page URL Supabase should redirect back to. */
  redirectUri: string;
  /** The agent identity this vault may hold (e.g. "friday@example.com"). When set,
   *  captureSession refuses any session whose verified email differs — otherwise ANY valid
   *  OS user's tokens posted to the callback would silently rebind this agent's identity. */
  expectedEmail?: string;
}

const NOT_CONFIGURED =
  "Orion Supabase project not configured — set ORION_SUPABASE_URL and ORION_SUPABASE_ANON_KEY";

/** The vault holds a long-lived rotating refresh token: owner-only (audit 2026-10-28 found it 0644). */
const SESSION_FILE_MODE = 0o600;

interface SessionStore {
  refresh_token?: string;
  email?: string;
}

interface AccessCacheEntry {
  token: string;
  exp: number;
}

export class OsAuth {
  private readonly agentDir: string;
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly redirectUri: string;
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly expectedEmail?: string;
  private cached: AccessCacheEntry | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(cfg: OsAuthConfig) {
    this.agentDir = cfg.agentDir;
    this.supabaseUrl = (cfg.supabaseUrl || process.env.ORION_SUPABASE_URL || "").trim().replace(/\/$/, "");
    this.anonKey = (cfg.supabaseAnonKey || process.env.ORION_SUPABASE_ANON_KEY || "").trim();
    this.redirectUri = cfg.redirectUri;
    this.storePath = path.join(this.agentDir, "os-session.json");
    this.lockPath = `${this.storePath}.refresh.lock`;
    this.expectedEmail = cfg.expectedEmail?.trim().toLowerCase() || undefined;
    if (!existsSync(this.agentDir)) mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    this.tightenSessionMode();
  }

  /** Best-effort: make an existing vault file owner-only (fixes files written before 0600 existed). */
  private tightenSessionMode(): void {
    try {
      if (existsSync(this.storePath) && (statSync(this.storePath).mode & 0o077) !== 0) chmodSync(this.storePath, SESSION_FILE_MODE);
    } catch { /* not ours to fail on — the next write sets the mode anyway */ }
  }

  /** True when the Supabase project (URL + anon key) is configured. */
  supabaseConfigured(): boolean {
    return Boolean(this.supabaseUrl && this.anonKey);
  }

  private requireSupabase(): void {
    if (!this.supabaseConfigured()) throw new Error(NOT_CONFIGURED);
  }

  private readStore(): SessionStore {
    try {
      return JSON.parse(readFileSync(this.storePath, "utf8")) as SessionStore;
    } catch {
      return {};
    }
  }

  private writeStore(s: SessionStore): void {
    // `mode` only applies when the file is created, so chmod after every write as well.
    writeFileSync(this.storePath, JSON.stringify(s, null, 2), { mode: SESSION_FILE_MODE });
    try { chmodSync(this.storePath, SESSION_FILE_MODE); } catch { /* best-effort */ }
  }

  /** Where to send the browser to start the one-time interactive Google sign-in via Supabase. */
  consentUrl(): string {
    this.requireSupabase();
    const p = new URLSearchParams({ provider: "google", redirect_to: this.redirectUri });
    return `${this.supabaseUrl}/auth/v1/authorize?${p.toString()}`;
  }

  osConfigured(): boolean {
    return this.supabaseConfigured() && Boolean(this.readStore().refresh_token);
  }

  osIdentity(): { email?: string } {
    return { email: this.readStore().email };
  }

  /**
   * Called by this app's POST /api/os/auth/callback once the client-side capture page has
   * extracted {access_token, refresh_token} from the redirect's URL fragment. Verifies the
   * identity via Supabase's own /auth/v1/user before persisting, so a malformed/foreign token
   * can't silently get stored as this agent's session.
   */
  async captureSession(accessToken: string, refreshToken: string): Promise<{ ok: boolean; email?: string; error?: string }> {
    if (!this.supabaseConfigured()) return { ok: false, error: NOT_CONFIGURED };
    const r = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: this.anonKey, Authorization: `Bearer ${accessToken}` },
      // A hung socket here would park the callback handler indefinitely — bound it.
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { ok: false, error: `identity check ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
    const j = (await r.json()) as { email?: string };
    if (!j.email) return { ok: false, error: "no email on verified session — refusing to store" };
    // "Some valid user" is not enough: without this check, any OS user's tokens POSTed to the
    // callback overwrite this agent's refresh token, silently rebinding every subsequent MCP
    // call to the caller's identity while the real agent integration goes dark.
    if (this.expectedEmail && j.email.trim().toLowerCase() !== this.expectedEmail) {
      return { ok: false, error: `session belongs to ${j.email}, not ${this.expectedEmail} — refusing to rebind this agent's OS identity` };
    }

    this.writeStore({ refresh_token: refreshToken, email: j.email });
    this.cached = null;
    return { ok: true, email: j.email };
  }

  /** Fresh, non-expired access token — from cache, or a rotation-safe refresh. */
  async getFreshOsJwt(): Promise<string> {
    if (this.cached && Date.now() < this.cached.exp - 60_000) return this.cached.token;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  // Cross-process refresh lock — a wx-created file next to the vault (same pattern as the
  // workqueue's pid-file mutex, sized down: stale takeover after 60s). The in-memory inFlight
  // promise only single-flights ONE OsAuth instance; two Next workers (or the app + a script)
  // sharing the vault file would otherwise both spend the same rotating refresh token, and
  // Supabase's reuse detection can revoke the whole session family — a lockout only an
  // interactive re-auth repairs.
  private async acquireRefreshLock(): Promise<void> {
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        await fsp.writeFile(this.lockPath, `${process.pid} ${new Date().toISOString()}`, { flag: "wx" });
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const st = await fsp.stat(this.lockPath).catch(() => null);
        if (!st || Date.now() - st.mtimeMs > 60_000) {
          // Holder crashed mid-refresh — steal and retry (another process may win; fine).
          await fsp.rm(this.lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Orion refresh lock timeout — another process is holding the token rotation");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  private async refresh(): Promise<string> {
    await this.acquireRefreshLock();
    try {
      return await this.refreshLocked();
    } finally {
      await fsp.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  private async refreshLocked(): Promise<string> {
    // Re-read INSIDE the lock: if another process just finished rotating, the vault now holds
    // the NEW refresh token — spending the pre-lock one would trip Supabase's reuse detection.
    // (The access token itself lives only in each process's memory, so after waiting we still
    // refresh — but with the rotated token, which is a fresh, valid single use.)
    this.requireSupabase();
    const rt = this.readStore().refresh_token;
    if (!rt) throw new Error("Orion not connected — visit /os/auth to sign in");

    const r = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: this.anonKey },
      body: JSON.stringify({ refresh_token: rt }),
      // The single-flight in getFreshOsJwt makes a hang here contagious: every concurrent AND
      // subsequent caller awaits this same promise, so one dead socket stops all authenticated
      // Orion traffic until the OS kills the connection. Bound it.
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      throw new Error(`Orion token refresh ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    }
    const j = (await r.json().catch(() => ({}))) as Partial<{ access_token: string; refresh_token: string; expires_in: number }>;
    if (!j.access_token || !j.refresh_token) {
      // A 200 with a malformed/truncated body must NOT touch the store — the
      // stored refresh token is the only way back in, and overwriting it with
      // undefined is a permanent lockout only interactive re-auth repairs
      // (the exact failure mode that has burned codex and FRIDAY sessions).
      throw new Error("Orion token refresh returned no access_token/refresh_token — keeping the stored session");
    }

    // Refresh tokens ROTATE on every use — persist the new one or the NEXT refresh 400s.
    const s = this.readStore();
    s.refresh_token = j.refresh_token;
    this.writeStore(s);

    this.cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }
}
