import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadOwnerProfile, clearOwnerProfileCache, getOwnerProfile, ownerFirstName, ownerPersonalEmail } from "./owner";

test("loads a valid profile from ORION_OWNER_PROFILE", async () => {
  clearOwnerProfileCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-test-"));
  const file = path.join(dir, "profile.json");
  await fs.writeFile(file, JSON.stringify({
    identity: { name: "T", workEmail: "t@example.com", excludedAccounts: ["p@example.com"] },
    boundaries: { personalMailOwner: "clara" },
  }));
  process.env.ORION_OWNER_PROFILE = file;
  try {
    const p = await loadOwnerProfile({ reload: true });
    assert.equal(p?.identity.workEmail, "t@example.com");
    assert.equal(p?.boundaries.personalMailOwner, "clara");
  } finally {
    delete process.env.ORION_OWNER_PROFILE;
  }
});

test("getOwnerProfile merges a partial profile over the fake default", async () => {
  clearOwnerProfileCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-test-"));
  const file = path.join(dir, "profile.json");
  await fs.writeFile(file, JSON.stringify({
    identity: { name: "Taylor Case", workEmail: "t@example.com", excludedAccounts: ["t.personal@example.com"] },
    boundaries: { personalMailOwner: "clara" },
  }));
  process.env.ORION_OWNER_PROFILE = file;
  try {
    const p = getOwnerProfile();
    assert.equal(p.identity.name, "Taylor Case");
    assert.equal(ownerFirstName(p), "Taylor");
    assert.equal(ownerPersonalEmail(p), "t.personal@example.com");
    // sections absent from the file fall back to the fake default, never undefined
    assert.equal(p.business?.name, "Example Lab");
  } finally {
    delete process.env.ORION_OWNER_PROFILE;
    clearOwnerProfileCache();
  }
});

test("getOwnerProfile accepts a directory in ORION_OWNER_PROFILE", async () => {
  clearOwnerProfileCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-test-"));
  await fs.writeFile(path.join(dir, "owner-profile.json"), JSON.stringify({
    identity: { name: "Dir Based", workEmail: "d@example.com", excludedAccounts: [] },
    boundaries: { personalMailOwner: "clara" },
  }));
  process.env.ORION_OWNER_PROFILE = dir;
  try {
    assert.equal(getOwnerProfile().identity.name, "Dir Based");
  } finally {
    delete process.env.ORION_OWNER_PROFILE;
    clearOwnerProfileCache();
  }
});

test("a malformed profile fails loudly rather than falling through", async () => {
  clearOwnerProfileCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-test-"));
  const file = path.join(dir, "bad.json");
  await fs.writeFile(file, JSON.stringify({ identity: { name: "no email" } }));
  process.env.ORION_OWNER_PROFILE = file;
  try {
    await assert.rejects(loadOwnerProfile({ reload: true }), /missing required fields/);
  } finally {
    delete process.env.ORION_OWNER_PROFILE;
  }
});
