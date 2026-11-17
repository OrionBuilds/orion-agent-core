// Deep work: a long-horizon agentic session that produces real file deliverables.
//
// Why this exists: the agents' chat surfaces are single-pass (router or planner → one reply). The
// quality bar the owner set — nine example Claude transcripts — is sustained multi-step work:
// research the subject, build branded DOCX/PDF/XLSX with the document skills, inspect the output,
// fix it, and deliver files. That is a Claude CLI session, not a chat completion. This module
// spawns exactly that session in an isolated per-task workspace and hands back whatever files it
// produced plus its final report.
//
// What this module deliberately does NOT do:
//   - Drive upload and owner notification. Those are per-agent (different token stores, folder
//     conventions, notify front doors) — each agent's deep-work wrapper handles delivery.
//   - Any outbound communication from inside the session. The tool allowlist is files + web + the
//     skills; sending anything still goes through each agent's approval-gated router tools.
//
// CLI flag notes (learned from FRIDAY's engines.ts, which documents the trap):
//   - `--dangerously-skip-permissions` silently VOIDS `--allowedTools`. Never combine. We use
//     `--permission-mode acceptEdits` + an explicit allowlist instead.
//   - Skills load natively from ~/.claude/skills (docx/pdf/xlsx/pptx are installed there); the
//     session sees them without any extra flag.
//   - No `--add-dir` — the session's cwd IS the workspace, which both scopes file tools naturally
//     and keeps every artifact in one collectable place.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawnProcess } from "../runner";
import { ownerFirstName } from "../config/owner";

export interface DeepWorkSpec {
  /** "clara" | "friday" — used for workspace pathing and log lines only. */
  agent: string;
  /** The agent's data dir (e.g. ~/.agentic-os/clara). Workspaces live under <dataDir>/deepwork/. */
  dataDir: string;
  /** What to produce, in the owner's words. The runner adds delivery instructions around it. */
  task: string;
  /** Optional client name — surfaces in the brief so documents get branded/addressed correctly. */
  client?: string;
  /** Extra grounding the agent wants in the brief (recent context, known facts, house style). */
  context?: string;
  /** CLI model override; default is the CLI's own default (the operator's subscription plan). */
  model?: string;
  /** Resolved claude binary path, for agents that pin one (CLARA_CLAUDE_BIN). Default "claude". */
  bin?: string;
  /** Hard wall clock. Deep tasks legitimately run long — a real-site audit with two branded PDFs
   *  blew a 30-minute budget on the first live attempt; default 60 minutes. */
  timeoutMs?: number;
  /**
   * Stall detector (Track B self-heal): if NO stream event arrives for this long, the session is
   * presumed wedged (hung tool, dead network) and killed so the queue's attempt logic can decide —
   * a stalled run must not silently eat the whole wall clock. Default 10 minutes; 0 disables.
   */
  stallMs?: number;
  /** Progress lines (assistant text snippets + tool activity), for activity feeds. */
  onEvent?: (line: string) => void;
  /** Fires with the workspace dir as soon as it exists — BEFORE the session starts, so queue
   *  consumers can durably record it for crash-sweep partial recovery. */
  onWorkspace?: (dir: string) => void;
  /** Observe the child (e.g. to offer a kill switch). */
  onSpawn?: (child: { kill: (sig?: NodeJS.Signals | number) => boolean }) => void;
}

export interface DeepWorkFile {
  /** Absolute path in the workspace. */
  path: string;
  name: string;
  bytes: number;
}

export interface DeepWorkResult {
  ok: boolean;
  /** The session's final report — summary, file list, and its NEEDS YOUR ATTENTION items. */
  summary: string;
  /** Files found in the workspace output/ dir after the session ended. */
  files: DeepWorkFile[];
  workspace: string;
  costUsd?: number;
  /**
   * Tool-usage evidence (§12's "instrument the CLI path" step): how many times the session
   * called each tool, keyed by the name that appeared on the stream — so MCP tools count under
   * their full `mcp__server__tool` names, which is exactly the granularity allowlist shrinking
   * needs. Counts only, never args (args can carry client data). Also persisted to
   * <workspace>/tool-usage.json so the evidence outlives the process and a sweep/report job can
   * aggregate it across runs.
   */
  toolUsage: Record<string, number>;
  error?: string;
}

/** The wrapper brief: how the session must behave and where deliverables must land. */
function brief(spec: DeepWorkSpec): string {
  const parts = [
    `You are ${spec.agent.toUpperCase()}, doing deep work for ${ownerFirstName()}. Work autonomously to completion — research, build, inspect your own output, fix, repeat until it is genuinely client-ready.`,
    spec.client ? `Client: ${spec.client}.` : "",
    spec.context ? `Context:\n${spec.context}` : "",
    `THE TASK:\n${spec.task}`,
    [
      "RULES:",
      "- Save every final deliverable into the ./output/ directory (create it). Nothing outside output/ is delivered.",
      "- Use the docx/pdf/xlsx/pptx skills for documents — branded, professional, the kind you'd hand a paying client. Verify rendered output before calling it done (e.g. render PDF pages to images and look at them).",
      "- Research with web search/fetch when the task references a site, market, or competitor. Ground claims in what you actually find.",
      "- Be honest at task level: label assumptions prominently in the documents, never invent data you don't have, and prefer flagging a gap over papering it.",
      "- You cannot send email/SMS or touch calendars from here — if the task implies outbound communication, produce a DRAFT as a deliverable instead.",
      "END WITH A FINAL REPORT in exactly this shape:",
      "SUMMARY: <what was produced and the key findings, a short paragraph>",
      "FILES: <one line per file in output/, with a one-line description>",
      `NEEDS YOUR ATTENTION: <numbered list of assumptions to confirm, decisions ${ownerFirstName()} must make, or follow-ups — or 'None.'>`,
    ].join("\n"),
  ];
  return parts.filter(Boolean).join("\n\n");
}

async function collectOutput(workspace: string): Promise<DeepWorkFile[]> {
  const outDir = path.join(workspace, "output");
  const files: DeepWorkFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await fs.stat(p).catch(() => null);
        if (st) files.push({ path: p, name: e.name, bytes: st.size });
      }
    }
  };
  await walk(outDir);
  return files;
}

/**
 * Run one deep-work session to completion. Resolves when the session ends (or times out) — callers
 * that want fire-and-forget hold the promise themselves and deliver on resolution.
 *
 * Never rejects for task-level failure: `ok:false` with an honest error instead, so a wrapper can
 * notify "it didn't work" rather than crash silently.
 */
export async function runDeepWork(spec: DeepWorkSpec): Promise<DeepWorkResult> {
  const id = `dw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const workspace = path.join(spec.dataDir, "deepwork", id);
  await fs.mkdir(path.join(workspace, "output"), { recursive: true });
  try { spec.onWorkspace?.(workspace); } catch { /* observer errors must not stop the run */ }

  const args = ["-p"];
  if (spec.model) args.push("--model", spec.model);
  args.push(
    "--output-format=stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    // Files + shell (the document skills run scripts) + web research + task tracking. No MCP, no
    // comms. NOTE: never add --dangerously-skip-permissions here — it silently voids this list.
    // The brief goes via STDIN, never as a positional arg: --allowedTools is variadic and eats a
    // trailing positional ("Input must be provided either through stdin or as a prompt argument"),
    // which made the very first live run exit 1 in four seconds.
    "--allowedTools",
    "Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch,TodoWrite,Skill",
  );

  const timeoutMs = spec.timeoutMs ?? 60 * 60_000;
  const stallMs = spec.stallMs ?? 10 * 60_000;

  return await new Promise<DeepWorkResult>((resolve) => {
    let finalText = "";
    let costUsd: number | undefined;
    const toolUsage: Record<string, number> = {};
    let buf = "";
    let timedOut = false;
    let stalled = false;
    let lastEventAt = Date.now();

    const child = spawnProcess(spec.bin ?? "claude", args, { cwd: workspace, input: brief(spec) });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    // Called after the kill timer is armed and guarded like the other observers: an unguarded
    // throw here would reject a promise documented as never rejecting, leaving a spawned child
    // running with no wall clock and no kill path.
    try { spec.onSpawn?.(child); } catch { /* observer errors must not stop the run */ }
    // Stall watchdog — checked coarsely; precision doesn't matter, liveness does.
    const stallTimer = stallMs > 0
      ? setInterval(() => {
          if (Date.now() - lastEventAt > stallMs) {
            stalled = true;
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }
        }, Math.min(stallMs / 4, 60_000))
      : null;

    const emit = (line: string) => {
      lastEventAt = Date.now();
      // Heartbeat file: lets an OUTSIDE observer (queue sweep, dashboards) see liveness without
      // holding a handle to this process. Best-effort by design.
      void fs.writeFile(path.join(workspace, "heartbeat"), String(lastEventAt)).catch(() => {});
      try { spec.onEvent?.(line); } catch { /* a broken observer must not kill the run */ }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as {
            type?: string;
            subtype?: string;
            result?: string;
            total_cost_usd?: number;
            message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
          };
          if (ev.type === "result") {
            if (typeof ev.result === "string") finalText = ev.result;
            if (typeof ev.total_cost_usd === "number") costUsd = ev.total_cost_usd;
          } else if (ev.type === "assistant" && ev.message?.content) {
            for (const c of ev.message.content) {
              if (c.type === "text" && c.text) emit(c.text.slice(0, 160));
              else if (c.type === "tool_use" && c.name) {
                toolUsage[c.name] = (toolUsage[c.name] ?? 0) + 1;
                emit(`[${c.name}]`);
              }
            }
          }
        } catch { /* partial frames and keep-alives are not fatal */ }
      }
    });

    child.on("close", async (code: number | null) => {
      clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
      const files = await collectOutput(workspace);
      // Persist the allowlist evidence whatever the outcome — a timed-out or stalled run's tool
      // trail is still evidence (often the most interesting kind). Best-effort by design.
      await fs
        .writeFile(path.join(workspace, "tool-usage.json"), JSON.stringify(toolUsage, null, 2), "utf8")
        .catch(() => {});
      if (stalled) {
        resolve({ ok: false, summary: finalText, files, workspace, costUsd, toolUsage, error: `stalled — no activity for ${Math.round(stallMs / 60000)} minutes` });
        return;
      }
      if (timedOut) {
        resolve({ ok: false, summary: finalText, files, workspace, costUsd, toolUsage, error: `timed out after ${Math.round(timeoutMs / 60000)} minutes` });
        return;
      }
      if (code !== 0 && !finalText) {
        resolve({ ok: false, summary: "", files, workspace, costUsd, toolUsage, error: `claude exited ${code}` });
        return;
      }
      // Success requires substance: a report, and (for build-shaped tasks) files. A session that
      // produced neither is a failure however politely it ended.
      const ok = Boolean(finalText.trim()) && (files.length > 0 || /SUMMARY:/i.test(finalText));
      resolve({ ok, summary: finalText, files, workspace, costUsd, toolUsage, error: ok ? undefined : "session ended without a report or deliverables" });
    });

    child.on("error", (e: Error) => {
      clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
      resolve({ ok: false, summary: "", files: [], workspace, toolUsage, error: String(e).slice(0, 200) });
    });
  });
}
