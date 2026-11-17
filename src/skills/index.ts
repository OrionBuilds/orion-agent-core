// Skills index/loader — the plan §9 "index now, load body on selection" primitive.
//
// Skills are agentskills.io-shaped directories (a folder holding SKILL.md with YAML frontmatter,
// optionally scripts/ and references/ beside it) — the same format as the deep-work document
// skills already installed under ~/.claude/skills, so a skill authored for the fleet's own tree
// works unchanged if dropped into a CLI skills dir, and vice versa.
//
// Progressive disclosure is the whole design (Q40 + §9): the model sees the INDEX — one line per
// skill, name + description + owner — and full SKILL.md bodies load on demand only when a skill
// is selected. The index is cached per root with content-hash invalidation (a changed SKILL.md
// changes its hash, which is also what the §7.3 diff pipeline keys cache busts on).
//
// This module reads and renders; it never writes. Skill mutation goes exclusively through the
// skilldiff pipeline (src/skilldiff) — propose → approval → commit, never an in-place write.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter, asString, asStringArray } from "./frontmatter";

export { parseFrontmatter, asString, asStringArray } from "./frontmatter";
export type { ParsedDoc } from "./frontmatter";

export interface SkillMeta {
  /** Frontmatter `name`, falling back to the directory name. */
  name: string;
  description: string;
  /** Owning agent — "clara" | "friday" | "all" (default). Frontmatter `owner`. */
  owner: string;
  /** Sub-agent ids this skill is scoped to, when the owner scopes it. Frontmatter `subagents`. */
  subagents: string[];
  /** Informational tool hints (frontmatter `allowed-tools`) — enforcement stays in authority/allowlists. */
  allowedTools: string[];
  /** Absolute path of the skill directory (scripts/references live beside SKILL.md). */
  dir: string;
  /** Absolute path of SKILL.md itself. */
  file: string;
  /** sha256 of the full SKILL.md content — the cache-bust key shared with the diff pipeline. */
  hash: string;
}

interface IndexCacheEntry {
  stamp: string;
  skills: SkillMeta[];
}

const indexCache = new Map<string, IndexCacheEntry>();

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function findSkillFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(path.join(dir, e.name));
      } else if (e.name === "SKILL.md") {
        found.push(path.join(dir, e.name));
      }
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * Index every skill under `rootDir` (recursively — a flat tree of `<skill>/SKILL.md` dirs is the
 * expected shape, but nesting works). Cached per root; invalidated when any SKILL.md's mtime
 * moves or the set of files changes. A skill whose frontmatter is missing/malformed still indexes
 * (name from its directory, empty description) — a broken header must not hide a whole skill.
 */
export async function indexSkills(rootDir: string): Promise<SkillMeta[]> {
  const files = await findSkillFiles(rootDir);
  const stats = await Promise.all(files.map((f) => fs.stat(f).catch(() => null)));
  const stamp = files.map((f, i) => `${f}:${stats[i]?.mtimeMs ?? 0}`).join("|");

  const cached = indexCache.get(rootDir);
  if (cached && cached.stamp === stamp) return cached.skills;

  const skills: SkillMeta[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue; // deleted between scan and read — next index() call re-stamps
    }
    const { frontmatter } = parseFrontmatter(raw);
    const dir = path.dirname(file);
    skills.push({
      name: asString(frontmatter.name) || path.basename(dir),
      description: asString(frontmatter.description) ?? "",
      owner: (asString(frontmatter.owner) || "all").toLowerCase(),
      subagents: asStringArray(frontmatter.subagents) ?? [],
      allowedTools: asStringArray(frontmatter["allowed-tools"]) ?? [],
      dir,
      file,
      hash: sha256(raw),
    });
  }
  indexCache.set(rootDir, { stamp, skills });
  return skills;
}

/** Skills visible to an agent: its own plus everything owned by "all". */
export async function listSkills(rootDir: string, opts: { agent?: string } = {}): Promise<SkillMeta[]> {
  const skills = await indexSkills(rootDir);
  if (!opts.agent) return skills;
  const agent = opts.agent.toLowerCase();
  return skills.filter((s) => s.owner === agent || s.owner === "all");
}

/**
 * Token search over name + description (implicit AND, case-insensitive), ranked by how many
 * tokens hit the name rather than only the description. Same visibility rule as listSkills.
 */
export async function searchSkills(
  rootDir: string,
  query: string,
  opts: { agent?: string; limit?: number } = {},
): Promise<SkillMeta[]> {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored: Array<{ skill: SkillMeta; score: number }> = [];
  for (const skill of await listSkills(rootDir, opts)) {
    const name = skill.name.toLowerCase();
    const desc = skill.description.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of tokens) {
      if (name.includes(t)) score += 2;
      else if (desc.includes(t)) score += 1;
      else all = false;
    }
    if (all) scored.push({ skill, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, opts.limit ?? 8))
    .map((s) => s.skill);
}

/** Full SKILL.md body for one skill, by name. Null when the agent can't see it or it's gone. */
export async function loadSkill(
  rootDir: string,
  name: string,
  opts: { agent?: string } = {},
): Promise<{ meta: SkillMeta; body: string } | null> {
  const meta = (await listSkills(rootDir, opts)).find((s) => s.name === name);
  if (!meta) return null;
  let raw: string;
  try {
    raw = await fs.readFile(meta.file, "utf8");
  } catch {
    return null;
  }
  return { meta, body: parseFrontmatter(raw).body };
}

/**
 * The progressive-disclosure index block — what the model sees BEFORE selecting a skill. One
 * line per skill; bodies stay on disk until loadSkill/renderSkillContext pulls one in.
 */
export function renderSkillIndex(skills: SkillMeta[]): string {
  if (!skills.length) return "No skills installed.";
  return skills
    .map((s) => `- ${s.name} (${s.owner}): ${s.description || "(no description)"}`)
    .join("\n");
}

/**
 * A selected skill rendered for injection into a deep-work brief's `context` field (or any
 * system-prompt tail): header carries provenance, body is the skill verbatim. The framing line
 * matters — a skill is working instructions, not a persona, and must not read as one.
 */
export function renderSkillContext(meta: SkillMeta, body: string): string {
  return [
    `SKILL: ${meta.name}`,
    meta.description ? `WHEN: ${meta.description}` : "",
    `Follow these working instructions where they apply to the task. They do not override your persona, gates, or the constitution.`,
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Test seam. */
export function clearSkillsCache(): void {
  indexCache.clear();
}
