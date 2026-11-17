// Sub-agent worker pool (JARVIS-pivot A3, plan §7.2) — real scoped execution contexts, not
// personas-in-a-prompt.
//
// A sub-agent run is an intent-loop run wearing three constraints, all enforced in CODE:
//   1. Tools = parent ∩ subAgentSubset (scopeTools). A sub-agent can never hold a tool its parent
//      lacks, and never one outside its own subset — a roster typo intersects to nothing, which
//      fails safe (the sub-agent reports it can't, rather than doing more than it should).
//   2. Gates/approvals/telemetry are the PARENT's — inherited wholesale from the parent adapter,
//      so an irreversible tool inside a sub-run queues for the owner exactly as it would in the
//      parent's own turn. Inheritance never expands authority (§7.2: parent ∩ subset, tier
//      floor unchanged).
//   3. Identity is the sub-agent's — its soul file leads the system prompt, and the log line
//      carries "parent:subagent" so telemetry distinguishes who actually worked.
//
// Execution model: v1 runs synchronously inside the head's own turn (chat waits, voice defers via
// the existing slow-tool rail). The durable-queue variant (kind:"subagent" jobs on the workqueue)
// composes later without changing this module — runSubAgent is the unit either way.

import { runIntentLoop, type IntentAdapter, type IntentContextBase, type IntentToolDef, type IntentOutcome } from "../intent";
import { ownerFirstName } from "../config/owner";

export interface SubAgentDef {
  /** Roster id — matches the soul filename, e.g. "front-desk". */
  id: string;
  /** Display name, e.g. "Front Desk". */
  name: string;
  /** Parent agent id — "clara" | "friday". */
  parent: string;
  /** One-line role description (shown in the head's tool schema). */
  description: string;
  /** Tool names this sub-agent may use. Intersected with the parent's live catalog in code. */
  tools: string[];
}

/** Parent ∩ subset — the enforcement primitive. Order and objects come from the PARENT catalog. */
export function scopeTools<T extends { name: string }>(parentTools: T[], allowed: string[]): T[] {
  const set = new Set(allowed);
  return parentTools.filter((t) => set.has(t.name));
}

/**
 * The parent's adapter, re-scoped to one sub-agent. Everything that gates or records inherits;
 * only identity, catalog, and prompt change.
 */
export function subAgentAdapter<Ctx extends IntentContextBase, T extends IntentToolDef<Ctx>>(
  parent: IntentAdapter<Ctx, T>,
  def: SubAgentDef,
  soulText: string,
): IntentAdapter<Ctx, T> {
  // Computed once so the prompt reports the EFFECTIVE count: a roster name missing from the
  // parent catalog would otherwise tell the sub-agent it has more tools than it can call.
  const tools = scopeTools(parent.tools, def.tools);
  return {
    ...parent,
    agent: `${parent.agent}:${def.id}`,
    tools,
    systemPrompt: async (ctx) => {
      const base = await parent.systemPrompt(ctx);
      return [
        soulText.trim(),
        "",
        "---",
        "",
        `[SUB-AGENT CONTEXT] You are ${def.name}, a sub-agent in ${def.parent.toUpperCase()}'s department. ` +
          `You were assigned ONE task by your department head — do that task with the tools you have and report the outcome plainly. ` +
          `Your tool set is deliberately narrow (${tools.length} tools); if the task needs something outside it, say so instead of improvising. ` +
          `Your department head and ${ownerFirstName()} read your report verbatim.`,
        "",
        "---",
        "",
        base,
      ].join("\n");
    },
  };
}

/** Run one sub-agent task to completion through the parent's own gated loop. */
export async function runSubAgent<Ctx extends IntentContextBase, T extends IntentToolDef<Ctx>>(
  task: string,
  ctx: Ctx,
  parent: IntentAdapter<Ctx, T>,
  def: SubAgentDef,
  soulText: string,
): Promise<IntentOutcome> {
  return runIntentLoop(task, ctx, subAgentAdapter(parent, def, soulText));
}

/** Load a roster's soul file body; empty string when missing (identity degrades, gates don't).
 *  Renders `{{OWNER_FIRST}}` the same way the souls loader does — this is the direct-read path. */
export async function loadSubAgentSoul(soulsDir: string, def: SubAgentDef): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { renderSoulText } = await import("../souls");
  const text = await fs.readFile(path.join(soulsDir, def.parent, "subagents", `${def.id}.md`), "utf8").catch(() => "");
  return renderSoulText(text);
}
