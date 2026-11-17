// SOP loader/runner — plan §9's machine-readable SOP format + §11's audit requirement.
//
// An SOP is a markdown file with YAML frontmatter (id, name, owner, trigger, steps, escalation)
// and a human-readable body. The frontmatter is the machine-checkable part: steps name the
// capability/tool they run at tool-level specificity, carry a gate (none | approval | tier3), an
// on_fail action, and an SLA — so "the agents follow SOPs" is checkable against a run record
// rather than aspirational (the plan's exact framing).
//
// This module is a LIBRARY, deliberately unwired: it lists/loads SOP files, renders one into a
// prompt-injectable checklist, and records per-run audit entries (followed vs deviated). It does
// not execute steps — execution stays with each agent's own gated tools, and the checklist text
// explicitly reminds the model that a gate: approval step goes through the approval queue.
//
// Audit entries are one JSON file per run under <dataDir>/sop/runs/, written tmp+rename (the
// workqueue rule: a crash mid-write must never truncate a record). SOP content itself mutates
// only via the skilldiff pipeline — never an in-place write from an agent.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter, asString } from "../skills/frontmatter";

export type SopGate = "none" | "approval" | "tier3";
export type SopOnFail = "retry" | "escalate" | "abort";

export interface SopStep {
  id: string;
  /** The capability/tool the step runs, at tool-level specificity — e.g. "email.draft",
   *  "docusign.send", "rollback_deploy". Bus capabilities and router tools share this field. */
  run: string;
  gate: SopGate;
  onFail: SopOnFail;
  /** e.g. "4h", "1d" — informational; SLA enforcement lives with each agent's scheduler. */
  sla?: string;
  /** Which agent performs the step when the SOP spans agents (over the bus). Defaults to owner. */
  agent?: string;
  /** One-line human note carried into the checklist. */
  note?: string;
}

export interface Sop {
  id: string;
  name: string;
  /** "clara" | "friday" | "all" (approval-escalation runs in every agent). */
  owner: string;
  /** e.g. { event: "deal.won" } or { schedule: "weekly" } — matched by the caller, not here. */
  trigger: Record<string, string>;
  steps: SopStep[];
  escalation: string;
  /** Absolute path + content hash, for provenance in audit entries and diff-pipeline cache busts. */
  file: string;
  hash: string;
  body: string;
}

export interface SopLoadResult {
  sops: Sop[];
  /** Malformed files, surfaced rather than silently dropped — a half-broken SOP is an incident. */
  invalid: Array<{ file: string; reason: string }>;
}

const GATES: SopGate[] = ["none", "approval", "tier3"];
const ON_FAILS: SopOnFail[] = ["retry", "escalate", "abort"];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseStep(raw: unknown, i: number): SopStep {
  if (!raw || typeof raw !== "object") throw new Error(`step ${i + 1} is not a mapping`);
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const run = asString(r.run);
  if (!id) throw new Error(`step ${i + 1} is missing id`);
  if (!run) throw new Error(`step "${id}" is missing run (the capability/tool it executes)`);
  const gate = (asString(r.gate) ?? "none") as SopGate;
  if (!GATES.includes(gate)) throw new Error(`step "${id}" has unknown gate "${gate}"`);
  const onFail = (asString(r.on_fail) ?? "escalate") as SopOnFail;
  if (!ON_FAILS.includes(onFail)) throw new Error(`step "${id}" has unknown on_fail "${onFail}"`);
  return {
    id,
    run,
    gate,
    onFail,
    sla: asString(r.sla),
    agent: asString(r.agent)?.toLowerCase(),
    note: asString(r.note),
  };
}

function parseSop(file: string, raw: string): Sop {
  const { frontmatter, body } = parseFrontmatter(raw);
  const id = asString(frontmatter.id);
  const name = asString(frontmatter.name);
  const owner = asString(frontmatter.owner)?.toLowerCase();
  if (!id) throw new Error("missing id");
  if (!name) throw new Error("missing name");
  if (!owner) throw new Error("missing owner");
  const stepsRaw = frontmatter.steps;
  if (!Array.isArray(stepsRaw) || !stepsRaw.length) throw new Error("steps must be a non-empty list");
  const steps = stepsRaw.map(parseStep);
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.id)) throw new Error(`duplicate step id "${s.id}"`);
    seen.add(s.id);
  }
  const trigger: Record<string, string> = {};
  if (frontmatter.trigger && typeof frontmatter.trigger === "object") {
    for (const [k, v] of Object.entries(frontmatter.trigger as Record<string, unknown>)) {
      const s = asString(v);
      if (s) trigger[k] = s;
    }
  }
  return {
    id,
    name,
    owner,
    trigger,
    steps,
    escalation: asString(frontmatter.escalation) ?? "",
    file,
    hash: sha256(raw),
    body,
  };
}

/** Load every *.md SOP under sopsDir (flat — SOPs don't nest; README.md is skipped). */
export async function loadSops(sopsDir: string): Promise<SopLoadResult> {
  let names: string[];
  try {
    names = await fs.readdir(sopsDir);
  } catch {
    return { sops: [], invalid: [] };
  }
  const sops: Sop[] = [];
  const invalid: Array<{ file: string; reason: string }> = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".md") || n.toUpperCase() === "README.MD") continue;
    const file = path.join(sopsDir, n);
    try {
      sops.push(parseSop(file, await fs.readFile(file, "utf8")));
    } catch (e) {
      invalid.push({ file, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { sops, invalid };
}

/** SOPs an agent runs: its own plus owner:"all" (e.g. approval escalation). */
export async function listSopsFor(sopsDir: string, agent: string): Promise<Sop[]> {
  const { sops } = await loadSops(sopsDir);
  const a = agent.toLowerCase();
  return sops.filter((s) => s.owner === a || s.owner === "all");
}

export async function loadSop(sopsDir: string, id: string): Promise<Sop | null> {
  const { sops } = await loadSops(sopsDir);
  return sops.find((s) => s.id === id) ?? null;
}

/**
 * Render one SOP as a prompt-injectable checklist. The framing lines are load-bearing: they
 * instruct the model that gated steps go through the approval queue (never executed directly),
 * and that every skip/deviation must be reported with a reason so the audit entry is honest.
 */
export function renderSopChecklist(sop: Sop): string {
  const lines = [
    `SOP: ${sop.name} (${sop.id}) — owner: ${sop.owner}`,
    Object.keys(sop.trigger).length
      ? `TRIGGER: ${Object.entries(sop.trigger).map(([k, v]) => `${k}=${v}`).join(", ")}`
      : "",
    "Work the steps in order. A step marked gate:approval or gate:tier3 must go through the approval queue — never execute it directly. If a step cannot be completed, follow its on-fail action and say so: every skipped or deviated step must be reported, with the reason, for the run record.",
    "STEPS:",
    ...sop.steps.map((s, i) => {
      const parts = [
        `${i + 1}. [${s.id}] run ${s.run}`,
        s.agent ? `via ${s.agent}` : "",
        `— gate: ${s.gate}; on fail: ${s.onFail}` + (s.sla ? `; SLA ${s.sla}` : ""),
        s.note ? `(${s.note})` : "",
      ];
      return parts.filter(Boolean).join(" ");
    }),
    sop.escalation ? `ESCALATION: ${sop.escalation}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export type SopStepStatus = "done" | "skipped" | "deviated" | "failed";

export interface SopRunStep {
  id: string;
  status: SopStepStatus;
  note?: string;
}

export interface SopRunInput {
  sopId: string;
  agent: string;
  steps: SopRunStep[];
  /** Correlates to the workqueue job / activity run that executed the SOP, when there is one. */
  runId?: string;
  outcome?: string;
  /** Hash of the SOP file as loaded for this run — pins the audit entry to an exact SOP version. */
  sopHash?: string;
}

export interface SopRunRecord extends SopRunInput {
  id: string;
  recordedAt: string;
  /** True only when every SOP step was recorded done — the checkable "followed the SOP" bit. */
  followed: boolean;
  /** One line per divergence: non-done statuses, plus SOP steps the run never recorded at all. */
  deviations: string[];
}

function runsDir(dataDir: string): string {
  return path.join(dataDir, "sop", "runs");
}

/**
 * Record one SOP run's audit entry. Pass the Sop so unrecorded steps count as deviations — a run
 * that silently omits a step must not audit as "followed". Written tmp+rename, one file per run.
 */
// Two audits recorded in the same millisecond would otherwise sort in arbitrary order (the list is
// newest-first by recordedAt), so hand out strictly increasing timestamps within a process.
let lastRecordMs = 0;
function nextRecordTime(): number {
  lastRecordMs = Math.max(Date.now(), lastRecordMs + 1);
  return lastRecordMs;
}

export async function recordSopRun(dataDir: string, input: SopRunInput, sop?: Sop): Promise<SopRunRecord> {
  const deviations: string[] = [];
  for (const s of input.steps) {
    if (s.status !== "done") deviations.push(`[${s.id}] ${s.status}${s.note ? `: ${s.note}` : ""}`);
  }
  if (sop) {
    const recorded = new Set(input.steps.map((s) => s.id));
    for (const s of sop.steps) {
      if (!recorded.has(s.id)) deviations.push(`[${s.id}] not recorded — step never reported`);
    }
  }
  const at = nextRecordTime();
  const record: SopRunRecord = {
    ...input,
    sopHash: input.sopHash ?? sop?.hash,
    id: `soprun_${at.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    recordedAt: new Date(at).toISOString(),
    followed: deviations.length === 0 && input.steps.length > 0,
    deviations,
  };
  const dir = runsDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, `${record.id}.json`);
  await fs.writeFile(`${f}.tmp`, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(`${f}.tmp`, f);
  return record;
}

/** Audit entries, newest first — the Office's "did the agents follow the SOP" surface reads this. */
export async function listSopRuns(
  dataDir: string,
  opts: { sopId?: string; limit?: number } = {},
): Promise<SopRunRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsDir(dataDir));
  } catch {
    return [];
  }
  const records: SopRunRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await fs.readFile(path.join(runsDir(dataDir), n), "utf8")) as SopRunRecord);
    } catch { /* one corrupt record must not hide the rest */ }
  }
  return records
    .filter((r) => !opts.sopId || r.sopId === opts.sopId)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    .slice(0, Math.max(1, opts.limit ?? 50));
}
