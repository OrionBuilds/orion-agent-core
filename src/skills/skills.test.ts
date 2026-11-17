import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  indexSkills,
  listSkills,
  searchSkills,
  loadSkill,
  renderSkillIndex,
  renderSkillContext,
  clearSkillsCache,
  parseFrontmatter,
} from "./index";

async function makeSkillsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-test-"));
  const write = async (name: string, content: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, "SKILL.md"), content);
  };
  await write(
    "pitch-deck",
    "---\nname: pitch-deck\ndescription: Build a client pitch deck as Google Slides.\nowner: friday\nsubagents: creative-studio\nallowed-tools: Read, Write, Bash\n---\n# Pitch deck\nBuild the deck.",
  );
  await write(
    "house-style",
    "---\nname: house-style\ndescription: House written voice for client-facing output.\nowner: all\n---\n# House style\nPlain language.",
  );
  await write("bare", "No frontmatter at all — still a skill body.");
  // Decoys the walker must skip
  await fs.mkdir(path.join(dir, "node_modules", "junk"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "junk", "SKILL.md"), "---\nname: junk\n---\nx");
  await fs.writeFile(path.join(dir, "README.md"), "not a skill");
  return dir;
}

test("indexes SKILL.md dirs, skipping node_modules; frontmatter-less files still index by dir name", async () => {
  clearSkillsCache();
  const dir = await makeSkillsDir();
  const skills = await indexSkills(dir);
  assert.deepEqual(skills.map((s) => s.name).sort(), ["bare", "house-style", "pitch-deck"]);
  const deck = skills.find((s) => s.name === "pitch-deck")!;
  assert.equal(deck.owner, "friday");
  assert.deepEqual(deck.subagents, ["creative-studio"]);
  assert.deepEqual(deck.allowedTools, ["Read", "Write", "Bash"]);
  assert.match(deck.hash, /^[0-9a-f]{64}$/);
  const bare = skills.find((s) => s.name === "bare")!;
  assert.equal(bare.owner, "all");
  assert.equal(bare.description, "");
});

test("listSkills scopes by agent: own + all, never another agent's", async () => {
  clearSkillsCache();
  const dir = await makeSkillsDir();
  const forClara = await listSkills(dir, { agent: "clara" });
  assert.deepEqual(forClara.map((s) => s.name).sort(), ["bare", "house-style"]);
  const forFriday = await listSkills(dir, { agent: "friday" });
  assert.ok(forFriday.some((s) => s.name === "pitch-deck"));
});

test("search ranks name hits above description hits and requires every token", async () => {
  clearSkillsCache();
  const dir = await makeSkillsDir();
  const hits = await searchSkills(dir, "pitch deck");
  assert.equal(hits[0]?.name, "pitch-deck");
  assert.deepEqual(await searchSkills(dir, "pitch nonexistent-token"), []);
  // Agent scoping applies to search too
  assert.deepEqual(await searchSkills(dir, "pitch", { agent: "clara" }), []);
});

test("loadSkill returns body without frontmatter; renderers produce index line and brief block", async () => {
  clearSkillsCache();
  const dir = await makeSkillsDir();
  const loaded = await loadSkill(dir, "pitch-deck");
  assert.ok(loaded);
  assert.equal(loaded!.body, "# Pitch deck\nBuild the deck.");
  assert.doesNotMatch(loaded!.body, /^---/);

  const index = renderSkillIndex(await indexSkills(dir));
  assert.match(index, /- pitch-deck \(friday\): Build a client pitch deck/);

  const brief = renderSkillContext(loaded!.meta, loaded!.body);
  assert.match(brief, /^SKILL: pitch-deck/);
  assert.match(brief, /do not override your persona/);
  assert.match(brief, /Build the deck\./);

  // Visibility rule holds on load too
  assert.equal(await loadSkill(dir, "pitch-deck", { agent: "clara" }), null);
});

test("index cache invalidates when a SKILL.md changes (hash moves with it)", async () => {
  clearSkillsCache();
  const dir = await makeSkillsDir();
  const before = (await indexSkills(dir)).find((s) => s.name === "house-style")!;
  await new Promise((r) => setTimeout(r, 20)); // coarse-mtime filesystems
  await fs.writeFile(
    path.join(dir, "house-style", "SKILL.md"),
    "---\nname: house-style\ndescription: UPDATED.\nowner: all\n---\nNew body.",
  );
  const after = (await indexSkills(dir)).find((s) => s.name === "house-style")!;
  assert.equal(after.description, "UPDATED.");
  assert.notEqual(after.hash, before.hash);
});

test("parseFrontmatter tolerates malformed yaml and missing frontmatter", () => {
  assert.deepEqual(parseFrontmatter("just a body"), { frontmatter: {}, body: "just a body" });
  const bad = parseFrontmatter("---\n\t: [unclosed\n---\nbody survives");
  assert.deepEqual(bad.frontmatter, {});
  assert.equal(bad.body, "body survives");
});
