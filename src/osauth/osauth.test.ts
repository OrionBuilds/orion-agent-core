// OsAuth hygiene (audit 2026-10-28): the vault file is owner-only, and there is no built-in
// Supabase project — an unconfigured agent is "not connected", never silently pointed elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OsAuth } from "./index";

function dir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "osauth-"));
}

test("an existing world-readable session file is tightened to 0600 on construction", () => {
  const d = dir();
  const f = path.join(d, "os-session.json");
  writeFileSync(f, JSON.stringify({ refresh_token: "rt", email: "agent@example.com" }));
  chmodSync(f, 0o644);
  new OsAuth({ agentDir: d, redirectUri: "http://x", supabaseUrl: "https://p.supabase.co", supabaseAnonKey: "anon" });
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("no supabase URL/key (cfg or env) ⇒ not configured, clear errors, no default project", async () => {
  const saved = [process.env.ORION_SUPABASE_URL, process.env.ORION_SUPABASE_ANON_KEY];
  delete process.env.ORION_SUPABASE_URL;
  delete process.env.ORION_SUPABASE_ANON_KEY;
  try {
    const d = dir();
    writeFileSync(path.join(d, "os-session.json"), JSON.stringify({ refresh_token: "rt" }));
    const a = new OsAuth({ agentDir: d, redirectUri: "http://x" });
    assert.equal(a.supabaseConfigured(), false);
    assert.equal(a.osConfigured(), false);
    assert.throws(() => a.consentUrl(), /not configured/);
    await assert.rejects(a.getFreshOsJwt(), /not configured/);
    const cap = await a.captureSession("a", "b");
    assert.equal(cap.ok, false);

    process.env.ORION_SUPABASE_URL = "https://env.supabase.co/";
    process.env.ORION_SUPABASE_ANON_KEY = "anon";
    const b = new OsAuth({ agentDir: d, redirectUri: "http://x" });
    assert.equal(b.osConfigured(), true);
    assert.match(b.consentUrl(), /^https:\/\/env\.supabase\.co\/auth\/v1\/authorize\?/);
  } finally {
    if (saved[0] === undefined) delete process.env.ORION_SUPABASE_URL; else process.env.ORION_SUPABASE_URL = saved[0];
    if (saved[1] === undefined) delete process.env.ORION_SUPABASE_ANON_KEY; else process.env.ORION_SUPABASE_ANON_KEY = saved[1];
  }
});
