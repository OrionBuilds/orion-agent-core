// Obsidian vault writer — run logs, transcripts, and meeting records land as markdown in the
// git-tracked office vault (plan Phase 0 PR 0.9; decisions Q10/Q22). Plain files, Obsidian-friendly
// frontmatter, date-bucketed folders. No Obsidian API — the vault is just a directory Obsidian
// happens to have open.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface VaultWriterOptions {
  /** Absolute path to the vault root (the folder Obsidian opens). */
  vaultPath: string;
}

export interface VaultEntry {
  /** Folder within the vault, e.g. "runs", "transcripts", "meetings", "SOPs/runs". */
  section: string;
  title: string;
  /** Markdown body. Written as-is below the frontmatter. */
  body: string;
  /** Extra frontmatter fields (agent, correlationId, participants, …). */
  meta?: Record<string, string | number | boolean | string[]>;
  /** Override the timestamp (defaults to now). */
  at?: Date;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "entry";
}

function fmValue(v: string | number | boolean | string[]): string {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

// Sections legitimately contain slashes ("SOPs/runs"), so we can't just strip separators — instead
// drop traversal segments so a caller-supplied section like "../../etc" can never write outside the
// vault root (write() is public and joins the section straight into a path).
function safeSection(section: string): string {
  const parts = section.split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");
  if (!parts.length) throw new Error(`invalid vault section: ${section}`);
  return path.join(...parts);
}

export class VaultWriter {
  private root: string;

  constructor(opts: VaultWriterOptions) {
    this.root = opts.vaultPath;
  }

  /**
   * Write one entry. Returns the absolute path written. Filenames are date-prefixed and
   * collision-suffixed, never overwritten — the vault is an archive, not a working set.
   */
  async write(entry: VaultEntry): Promise<string> {
    const at = entry.at ?? new Date();
    const day = at.toISOString().slice(0, 10);
    const dir = path.join(this.root, safeSection(entry.section), day.slice(0, 7)); // section/YYYY-MM/
    await fs.mkdir(dir, { recursive: true });

    const base = `${day} ${slug(entry.title)}`;

    const fm = [
      "---",
      `title: ${JSON.stringify(entry.title)}`,
      `created: ${at.toISOString()}`,
      ...Object.entries(entry.meta ?? {}).map(([k, v]) => `${k}: ${fmValue(v)}`),
      "---",
      "",
    ].join("\n");

    // Exclusive create (wx), not probe-then-write: two concurrent writers can both see the same
    // name as free and the second would overwrite the first — which breaks the "never overwritten"
    // archive guarantee. EEXIST just advances to the next suffix.
    for (let n = 1; ; n++) {
      const file = path.join(dir, n === 1 ? `${base}.md` : `${base} (${n}).md`);
      try {
        await fs.writeFile(file, fm + entry.body + "\n", { encoding: "utf8", flag: "wx" });
        return file;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }

  /** Convenience: a run log with the standard shape the Office's activity modal links to. */
  async writeRunLog(input: {
    agent: string;
    runId: string;
    summary: string;
    log: string;
    outcome: "ok" | "failed" | "capped";
  }): Promise<string> {
    return this.write({
      section: "runs",
      title: `${input.agent} run ${input.runId.slice(0, 8)}`,
      meta: { agent: input.agent, runId: input.runId, outcome: input.outcome },
      body: `## Summary\n\n${input.summary}\n\n## Log\n\n\`\`\`\n${input.log}\n\`\`\``,
    });
  }

  /** Convenience: a conversation/meeting transcript. */
  async writeTranscript(input: {
    kind: "chat" | "meeting" | "call";
    title: string;
    participants: string[];
    turns: Array<{ speaker: string; text: string; at?: string }>;
  }): Promise<string> {
    const body = input.turns
      .map((t) => `**${t.speaker}**${t.at ? ` · ${t.at}` : ""}\n\n${t.text}`)
      .join("\n\n---\n\n");
    return this.write({
      section: input.kind === "meeting" ? "meetings" : "transcripts",
      title: input.title,
      meta: { kind: input.kind, participants: input.participants },
      body,
    });
  }
}
