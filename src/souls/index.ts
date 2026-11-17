// Souls loader — assembles an agent's (or sub-agent's) system-prompt prefix from the souls
// package's content tree, in the loading order its README mandates:
//
//   constitution.md → <agent>/persona.md → <agent>/learned.md → <agent>/subagents/<id>.md
//
// Nothing later may override anything earlier — enforced here by ORDER (the constitution is
// always first, and instructs that nothing below it wins), and by the diff pipeline's deny list
// (plan §7.3) for writes. learned.md is optional (starts absent; agent-appended via
// diff → approval → git commit).
//
// Content is cached per (soulsDir, agent, subagent) with mtime-based invalidation — read from disk
// per call in spirit (Q40) without re-reading four files on every message when nothing changed.

import { promises as fs } from "node:fs";
import path from "node:path";
import { ownerFirstName } from "../config/owner";

export type SoulAgent = "clara" | "friday";

/**
 * Owner-placeholder substitution (plan §3.2 / PR 0.10): soul markdown carries `{{OWNER_FIRST}}`
 * instead of a literal first name, and the placeholder is rendered at load time from the owner
 * profile (the clearly-fake default when no profile is present). Applied to EVERY part —
 * constitution, persona, learned, subagent — and to the workerpool's direct subagent-soul reads.
 */
export function renderSoulText(text: string): string {
  return text.replaceAll("{{OWNER_FIRST}}", ownerFirstName());
}

export interface SoulParts {
  constitution: string;
  persona: string;
  learned: string | null;
  subagent: string | null;
}

interface CacheEntry {
  key: string;
  stamp: string;
  parts: SoulParts;
}

let cache: CacheEntry | null = null;

async function readOrNull(file: string): Promise<{ text: string; mtime: number } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    return { text, mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Load the parts. Throws if the constitution or the agent's persona is missing — those are
 *  load-bearing; a fleet running without its constitution is a misconfiguration, not a fallback. */
export async function loadSoul(soulsDir: string, agent: SoulAgent, subagentId?: string): Promise<SoulParts> {
  const files = {
    constitution: path.join(soulsDir, "constitution.md"),
    persona: path.join(soulsDir, agent, "persona.md"),
    learned: path.join(soulsDir, agent, "learned.md"),
    subagent: subagentId ? path.join(soulsDir, agent, "subagents", `${subagentId}.md`) : null,
  };

  const [constitution, persona, learned, subagent] = await Promise.all([
    readOrNull(files.constitution),
    readOrNull(files.persona),
    readOrNull(files.learned),
    files.subagent ? readOrNull(files.subagent) : Promise.resolve(null),
  ]);

  if (!constitution) throw new Error(`souls: constitution.md not found under ${soulsDir}`);
  if (!persona) throw new Error(`souls: ${agent}/persona.md not found under ${soulsDir}`);
  if (subagentId && !subagent) throw new Error(`souls: ${agent}/subagents/${subagentId}.md not found`);

  const key = `${soulsDir}|${agent}|${subagentId ?? ""}`;
  // The cached parts hold text already rendered through renderSoulText, so the owner's first name
  // must be part of the stamp — otherwise a profile change keeps serving the old name until a soul
  // file happens to be rewritten or the process restarts.
  const stamp = [constitution.mtime, persona.mtime, learned?.mtime ?? 0, subagent?.mtime ?? 0, ownerFirstName()].join(":");
  if (cache?.key === key && cache.stamp === stamp) return cache.parts;

  const parts: SoulParts = {
    constitution: renderSoulText(constitution.text),
    persona: renderSoulText(persona.text),
    learned: learned ? renderSoulText(learned.text) : null,
    subagent: subagent ? renderSoulText(subagent.text) : null,
  };
  cache = { key, stamp, parts };
  return parts;
}

/** The assembled system-prompt prefix, in mandated order, separated clearly. */
export async function soulPrompt(soulsDir: string, agent: SoulAgent, subagentId?: string): Promise<string> {
  const p = await loadSoul(soulsDir, agent, subagentId);
  return [p.constitution, p.persona, p.learned, p.subagent]
    .filter((s): s is string => Boolean(s?.trim()))
    .join("\n\n---\n\n");
}

/** Test seam. */
export function clearSoulCache(): void {
  cache = null;
}
