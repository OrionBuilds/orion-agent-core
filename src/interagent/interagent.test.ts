// Tests for verifyInteragentSecret's trust boundaries.
//
// The Cloudflare-Access path trusts ONLY the middleware-set ACCESS_VERIFIED_HEADER — the marker a
// perimeter middleware stamps AFTER cryptographically verifying the Access JWT and stripping any
// client copy. It does NOT trust the raw, forgeable `Cf-Access-Jwt-Assertion` header (that was the
// pre-2026-09 bypass). This boundary is shared by ~10 routes across all agents, so a
// regression here silently re-breaks (or re-opens) every one of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyInteragentSecret, ACCESS_VERIFIED_HEADER } from "./index";

function req(headers: Record<string, string>): Request {
  return new Request("http://ignored.invalid/", { headers });
}

const SECRET = "test-secret-value";

test("no secret configured: everything passes (auth intentionally off)", () => {
  delete process.env.INTERAGENT_SHARED_SECRET;
  assert.equal(verifyInteragentSecret(req({})), true);
  assert.equal(verifyInteragentSecret(req({ host: "friday.example.com" })), true);
});

test("secret configured: the matching header still passes (the real inter-agent path)", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    assert.equal(
      verifyInteragentSecret(req({ "x-interagent-secret": SECRET, host: "friday.example.com" })),
      true,
    );
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("secret configured, wrong/missing header, no trust signal: fails closed", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    assert.equal(
      verifyInteragentSecret(req({ host: "friday.example.com" })),
      false,
      "a plain tunnel request with no secret and no verified marker must be rejected",
    );
    assert.equal(verifyInteragentSecret(req({ "x-interagent-secret": "wrong", host: "friday.example.com" })), false);
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("secret configured, loopback host, no header: an owner's own browser must pass", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    // IPv6 loopback is bracketed in a Host header ("[::1]:port"); a bare "::1" is not a valid Host
    // form and is intentionally not parsed as loopback.
    for (const host of ["127.0.0.1:3737", "127.0.0.1", "localhost:3939", "localhost", "[::1]:8080"]) {
      assert.equal(verifyInteragentSecret(req({ host })), true, `loopback host "${host}" should be trusted without the secret`);
    }
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("secret configured, loopback Host but a NON-loopback X-Forwarded-Host: fail closed", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    // A proxy may preserve Host while revealing the real origin via X-Forwarded-Host. Treating
    // either header as external is the fail-closed direction — mirrors the apps' own middleware.
    assert.equal(
      verifyInteragentSecret(req({ host: "127.0.0.1:3737", "x-forwarded-host": "attacker.example.com" })),
      false,
    );
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("VULN FIX: raw / forged Cf-Access-Jwt-Assertion header is NO LONGER trusted", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    // Pre-fix, presence of a JWT-shaped Cf-Access-Jwt-Assertion returned true regardless of whether
    // the token was ever verified — the bypass. The raw header is client-forgeable and must not
    // grant trust; only the middleware-set marker (next test) may. Well-formed and malformed values
    // alike are rejected.
    for (const v of ["some.jwt.value", "anything", "a.b", "..", "a b.c.d", ""]) {
      assert.equal(
        verifyInteragentSecret(req({ host: "friday.example.com", "cf-access-jwt-assertion": v })),
        false,
        `raw Cf-Access-Jwt-Assertion ${JSON.stringify(v)} must not grant trust — it is client-forgeable`,
      );
    }
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("Access-verified marker (set by a verifying perimeter middleware): passes; bogus value: fails", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    assert.equal(
      verifyInteragentSecret(req({ host: "friday.example.com", [ACCESS_VERIFIED_HEADER]: "1" })),
      true,
      "a request the perimeter middleware verified + marked must be trusted",
    );
    for (const v of ["0", "true", "yes", ""]) {
      assert.equal(
        verifyInteragentSecret(req({ host: "friday.example.com", [ACCESS_VERIFIED_HEADER]: v })),
        false,
        `a non-'1' marker value ${JSON.stringify(v)} must not be trusted`,
      );
    }
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("secret configured, non-loopback host, NO Access marker: still fails closed (genuine cross-agent path)", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    // The actual cross-agent-over-the-tunnel case (no human, no Access session) must still require
    // the shared secret. The fix only ADDS a stricter marker path; it must never remove this one.
    assert.equal(verifyInteragentSecret(req({ host: "friday.example.com" })), false);
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});
