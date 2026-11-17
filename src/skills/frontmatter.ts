// Parse `--- yaml --- body` markdown files (SKILL.md, SOP files, souls-adjacent content).
// Ported from FRIDAY's frontmatter.ts (src/lib/friday/frontmatter.ts) so the fleet has ONE
// tolerant parser instead of three drifting copies — same js-yaml engine, same rule: files with
// no frontmatter (or malformed frontmatter) return an empty object + the whole content as body,
// never an error. Content files are operator-authored; a stray tab must not take a catalog down.

// Named import, not default: FRIDAY's original runs under Next's bundler, which synthesizes a
// default for CJS modules — raw Node's ESM loader does not, and this package's tests run on raw
// Node. `load` is a real named export either way.
import { load as yamlLoad } from "js-yaml";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): ParsedDoc {
  const m = raw.match(FM_RE);
  if (!m) return { frontmatter: {}, body: raw.trim() };
  let fm: Record<string, unknown> = {};
  try {
    const loaded = yamlLoad(m[1]);
    if (loaded && typeof loaded === "object") fm = loaded as Record<string, unknown>;
  } catch {
    /* malformed frontmatter — treat as none */
  }
  return { frontmatter: fm, body: (m[2] ?? "").trim() };
}

/** Coerce a frontmatter value that may be a string, array, or comma-list into string[]. */
export function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

export function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
