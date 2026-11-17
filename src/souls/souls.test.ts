import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSoul, soulPrompt, clearSoulCache } from "./index";
import { clearOwnerProfileCache, DEFAULT_OWNER_PROFILE } from "../config/owner";
import { loadSubAgentSoul } from "../workerpool";

async function makeSoulsDir(withLearned = false): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "souls-test-"));
  await fs.writeFile(path.join(dir, "constitution.md"), "# Constitution\nNever claim unverified actions.");
  await fs.mkdir(path.join(dir, "clara", "subagents"), { recursive: true });
  await fs.writeFile(path.join(dir, "clara", "persona.md"), "# CLARA\nDry, precise.");
  await fs.writeFile(path.join(dir, "clara", "subagents", "scheduler.md"), "# Scheduler\nCraft layer.");
  if (withLearned) await fs.writeFile(path.join(dir, "clara", "learned.md"), "The owner hates 8am meetings.");
  return dir;
}

test("loads in mandated order; learned.md is optional", async () => {
  clearSoulCache();
  const dir = await makeSoulsDir(false);
  const parts = await loadSoul(dir, "clara");
  assert.match(parts.constitution, /Never claim/);
  assert.match(parts.persona, /Dry, precise/);
  assert.equal(parts.learned, null);

  const prompt = await soulPrompt(dir, "clara", "scheduler");
  const order = [prompt.indexOf("Constitution"), prompt.indexOf("CLARA"), prompt.indexOf("Scheduler")];
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "constitution before persona before subagent");
});

test("learned.md slots between persona and subagent when present", async () => {
  clearSoulCache();
  const dir = await makeSoulsDir(true);
  const prompt = await soulPrompt(dir, "clara", "scheduler");
  const iPersona = prompt.indexOf("Dry, precise");
  const iLearned = prompt.indexOf("8am meetings");
  const iSub = prompt.indexOf("Scheduler");
  assert.ok(iPersona < iLearned && iLearned < iSub);
});

test("missing constitution or persona throws; missing named subagent throws", async () => {
  clearSoulCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "souls-empty-"));
  await assert.rejects(loadSoul(dir, "clara"), /constitution/);

  const dir2 = await makeSoulsDir();
  await assert.rejects(loadSoul(dir2, "friday"), /persona/);
  await assert.rejects(loadSoul(dir2, "clara", "nonexistent"), /subagents\/nonexistent/);
});

async function makePlaceholderSoulsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "souls-owner-"));
  await fs.writeFile(path.join(dir, "constitution.md"), "# Constitution\n{{OWNER_FIRST}} reads every report.");
  await fs.mkdir(path.join(dir, "clara", "subagents"), { recursive: true });
  await fs.writeFile(path.join(dir, "clara", "persona.md"), "# CLARA\nYou work for {{OWNER_FIRST}}.");
  await fs.writeFile(path.join(dir, "clara", "learned.md"), "{{OWNER_FIRST}} hates 8am meetings.");
  await fs.writeFile(path.join(dir, "clara", "subagents", "scheduler.md"), "# Scheduler\nGuard {{OWNER_FIRST}}'s focus time.");
  return dir;
}

test("{{OWNER_FIRST}} renders from the profile in every soul part, including subagent souls", async () => {
  clearSoulCache();
  clearOwnerProfileCache();
  const profDir = await fs.mkdtemp(path.join(os.tmpdir(), "souls-prof-"));
  const profile = path.join(profDir, "profile.json");
  await fs.writeFile(profile, JSON.stringify({
    identity: { name: "Taylor Case", workEmail: "t@example.com", excludedAccounts: [] },
    boundaries: { personalMailOwner: "clara" },
  }));
  process.env.ORION_OWNER_PROFILE = profile;
  try {
    const dir = await makePlaceholderSoulsDir();
    const prompt = await soulPrompt(dir, "clara", "scheduler");
    assert.doesNotMatch(prompt, /\{\{OWNER_FIRST\}\}/, "no placeholder survives rendering");
    assert.match(prompt, /Taylor reads every report/);       // constitution
    assert.match(prompt, /You work for Taylor/);             // persona
    assert.match(prompt, /Taylor hates 8am meetings/);       // learned
    assert.match(prompt, /Guard Taylor's focus time/);       // subagent

    // The workerpool's direct-read path renders too.
    const sub = await loadSubAgentSoul(dir, { id: "scheduler", name: "Scheduler", parent: "clara", description: "", tools: [] });
    assert.match(sub, /Guard Taylor's focus time/);
    assert.doesNotMatch(sub, /\{\{OWNER_FIRST\}\}/);
  } finally {
    delete process.env.ORION_OWNER_PROFILE;
    clearOwnerProfileCache();
    clearSoulCache();
  }
});

test("{{OWNER_FIRST}} falls back to the fake default profile's first name", async () => {
  clearSoulCache();
  clearOwnerProfileCache();
  // An empty profile merges wholly onto DEFAULT_OWNER_PROFILE — the same values a fresh clone
  // with no profile at all runs on (pointing the env var at it keeps the test deterministic on
  // machines that DO have a real ~/.agentic-os profile).
  const profDir = await fs.mkdtemp(path.join(os.tmpdir(), "souls-prof-default-"));
  const profile = path.join(profDir, "profile.json");
  await fs.writeFile(profile, "{}");
  process.env.ORION_OWNER_PROFILE = profile;
  try {
    const dir = await makePlaceholderSoulsDir();
    const prompt = await soulPrompt(dir, "clara", "scheduler");
    const fakeFirst = DEFAULT_OWNER_PROFILE.identity.firstName!;
    assert.doesNotMatch(prompt, /\{\{OWNER_FIRST\}\}/);
    assert.match(prompt, new RegExp(`${fakeFirst} reads every report`));
    assert.match(prompt, new RegExp(`Guard ${fakeFirst}'s focus time`));
  } finally {
    delete process.env.ORION_OWNER_PROFILE;
    clearOwnerProfileCache();
    clearSoulCache();
  }
});

test("cache invalidates on file change", async () => {
  clearSoulCache();
  const dir = await makeSoulsDir();
  const first = await soulPrompt(dir, "clara");
  assert.doesNotMatch(first, /UPDATED/);
  // Ensure mtime moves even on coarse filesystems
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(dir, "clara", "persona.md"), "# CLARA\nUPDATED persona.");
  const second = await soulPrompt(dir, "clara");
  assert.match(second, /UPDATED/);
});
