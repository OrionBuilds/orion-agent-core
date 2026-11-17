// Skill-diff pipeline — plan §7.3: agents improve their own skills, SOPs, and soul/learned.md
// ONLY by proposing a unified diff that goes through approval and lands as a git commit. Never an
// in-place write. This module is the library half: validation (deny list), gate-weakening
// badging, the proposal state machine (built on the shared proposals scaffold, so the rows land
// in each agent's existing Collection-backed approvals store and UI), and diff application.
//
// The git half is deliberately caller-supplied: `applyWrite` receives the fully-applied new text
// and is where the runtime commits on a branch with the rationale + run ids in the message
// (§7.3 step 3). The default writer is tmp+rename to disk — correct for tests and for a dev loop,
// but production wiring MUST supply the committing writer, because revert-is-git-revert only
// works if every applied diff is a commit.
//
// Hard rules enforced here, not by prompt:
//   - deny list: authority/config/boundary paths cannot be targeted AT ALL (constitution,
//     personas, evals, agent-core authority, owner config, live-write ladders). Proposals
//     against them are refused before a row is ever created.
//   - allow roots: a diff may only target content under the skills/sops/souls trees — everything
//     else is out of reach by default, so the deny list is a second fence, not the only one.
//   - gate-weakening badge: a diff that deletes or rewrites protective language (gates, approval
//     requirements, tiers, refusals, boundaries) is flagged `[GATE-WEAKENING]` in the approval
//     row's action so it renders with a distinct badge in review. Flagged, never auto-blocked —
//     the owner decides; the pipeline's job is to make sure they can't miss it.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Collection } from "../store";
import { createProposalScaffold, type BaseApproval, type ProposalScaffoldConfig } from "../proposals";

// ---------------------------------------------------------------------------
// Unified diff parse + apply
// ---------------------------------------------------------------------------

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  /** Body lines with their leading marker: " " context, "-" delete, "+" add. */
  lines: string[];
  /** "\ No newline at end of file" seen after an old-side line (the ORIGINAL lacks a final \n). */
  noNewlineOld?: boolean;
  /** "\ No newline at end of file" seen after a "+" line (the RESULT must lack a final \n). */
  noNewlineNew?: boolean;
}

export interface ParsedDiff {
  /** Path from the `+++ b/...` header, normalized to forward slashes; null when headerless. */
  target: string | null;
  /** True when `--- /dev/null` — the diff creates the file. */
  isNewFile: boolean;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripDiffPath(p: string): string {
  const clean = p.trim().replace(/\\/g, "/");
  return clean.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split(/\r?\n/);
  let target: string | null = null;
  let isNewFile = false;
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    // "--- "/"+++ " are file headers ONLY outside a hunk body: inside one, a deletion of the
    // content line "-- note" arrives as "--- note" (and "++ note" as "+++ note"). Treating those
    // as headers used to null out `current` and silently discard the rest of the hunk — a wrong
    // apply that also hid removals from detectGateWeakening. Markdown/YAML content hits this.
    if (!current && line.startsWith("--- ")) {
      isNewFile = line.slice(4).trim() === "/dev/null";
    } else if (!current && line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p.trim() !== "/dev/null") target = stripDiffPath(p);
    } else if (HUNK_RE.test(line)) {
      const m = line.match(HUNK_RE)!;
      current = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      hunks.push(current);
    } else if (current && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) {
      current.lines.push(line);
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — applies to the immediately preceding body line. Dropping
      // it entirely made applyUnifiedDiff lose the file's trailing-newline state, so the written
      // file differed from the reviewed result and the next proposal's baseHash drifted.
      const prev = current?.lines[current.lines.length - 1];
      if (current && prev !== undefined) {
        if (prev.startsWith("+")) current.noNewlineNew = true;
        else if (prev.startsWith("-")) current.noNewlineOld = true;
        else { current.noNewlineOld = true; current.noNewlineNew = true; }
      }
    } else {
      current = null; // headers/garbage between hunks end the current hunk
    }
  }
  if (!hunks.length) throw new Error("diff contains no hunks");
  return { target, isNewFile, hunks };
}

/**
 * Apply a single-file unified diff to `original`. Strict: every context and deletion line must
 * match the original exactly at its stated position — a mismatch throws rather than fuzzily
 * applying, because a drifted base means the approval was reviewed against text that no longer
 * exists. (The executor pairs this with a base-hash check for the same reason.)
 */
export function applyUnifiedDiff(original: string, diff: string): string {
  const { hunks, isNewFile } = parseUnifiedDiff(diff);
  const src = original.length ? original.split("\n") : [];
  if (isNewFile && src.length) throw new Error("diff declares a new file but the target already has content");

  const out: string[] = [];
  let cursor = 0; // 0-based index into src

  for (const hunk of hunks) {
    // A zero old-start means "insert at top of an empty file" (git emits @@ -0,0 +1,N @@).
    const hunkStart = Math.max(0, hunk.oldStart - 1);
    if (hunkStart < cursor) throw new Error("hunks overlap or are out of order");
    while (cursor < hunkStart) {
      if (cursor >= src.length) throw new Error(`hunk @@ -${hunk.oldStart} starts past end of file`);
      out.push(src[cursor++]);
    }
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || marker === "-") {
        if (cursor >= src.length || src[cursor] !== text) {
          throw new Error(
            `diff does not apply: expected ${JSON.stringify(text)} at line ${cursor + 1}, found ${JSON.stringify(src[cursor] ?? "<eof>")}`,
          );
        }
        if (marker === " ") out.push(src[cursor]);
        cursor++;
      } else {
        out.push(text);
      }
    }
  }
  while (cursor < src.length) out.push(src[cursor++]);
  let text = out.join("\n");

  // Trailing-newline reconciliation. split/join already round-trips the original's final \n when
  // no hunk touches EOF (the trailing "" element survives the tail copy); the markers only matter
  // when the last hunk rewrote the end of the file, and they are only ever emitted at EOF.
  const last = hunks[hunks.length - 1];
  if (last?.noNewlineNew) {
    if (text.endsWith("\n")) text = text.slice(0, -1);
  } else if (last?.noNewlineOld) {
    // The old side lacked the final newline and the new side carries no marker — the reviewed
    // result ends WITH one.
    if (text.length && !text.endsWith("\n")) text += "\n";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Deny list + gate-weakening detection
// ---------------------------------------------------------------------------

/**
 * Paths the pipeline cannot target at all (§7.3's hard rule), matched as segments/basenames of
 * the normalized relative path. Human-authored authority surfaces: the constitution, personas and
 * their evals (souls README's editability table), agent-core authority + owner config (§3.2/§12),
 * and any live-write ladder (money-path governance).
 */
export const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /(^|\/)constitution\.md$/i,
  /(^|\/)persona\.md$/i,
  /(^|\/)evals(\/|$)/i,
  /(^|\/)authority(\/|$)/i,
  /(^|\/)config\/owner[^/]*$/i,
  /(^|\/)livewrites[^/]*$/i,
];

/** Where diffs MAY land: the fleet's writable content trees. Everything else is unreachable. */
export const DEFAULT_ALLOW_ROOTS = ["skills/", "sops/", "souls/"];

export interface TargetCheck {
  allowed: boolean;
  reason?: string;
}

/** Validate a repo-relative target path against allow roots + deny patterns. Deny wins. */
export function checkDiffTarget(
  relPath: string,
  opts: { allowRoots?: string[]; denyPatterns?: RegExp[] } = {},
): TargetCheck {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || path.isAbsolute(p) || p.split("/").includes("..")) {
    return { allowed: false, reason: "target must be a repo-relative path with no traversal" };
  }
  const roots = opts.allowRoots ?? DEFAULT_ALLOW_ROOTS;
  if (!roots.some((r) => p.startsWith(r))) {
    return { allowed: false, reason: `target is outside the writable content roots (${roots.join(", ")})` };
  }
  for (const deny of opts.denyPatterns ?? DEFAULT_DENY_PATTERNS) {
    if (deny.test(p)) {
      return { allowed: false, reason: `target matches the safety deny list (${deny.source})` };
    }
  }
  return { allowed: true };
}

/** Protective language whose removal marks a diff as gate-weakening. Broad on purpose — this
 *  badges for human review, it never blocks, so a false positive costs one extra look. */
const GATE_TOKENS = /\bgate\b|\bapproval\b|\btier\s*3\b|\btier:\s*/i;
const PROTECTIVE_TOKENS = /\bnever\b|\bmust not\b|\bdo not\b|\bdeny\b|\bboundar|\bescalat|\brefus|\brequire[sd]?\b/i;

export interface GateWeakeningCheck {
  flagged: boolean;
  reasons: string[];
}

/**
 * A diff weakens a gate when it REMOVES a line carrying gate/approval configuration or
 * protective ("never/must not/refuse/escalate/boundary") language, or rewrites `gate: approval|
 * tier3` down to `gate: none`. Additions alone never flag — tightening is not weakening.
 */
export function detectGateWeakening(diff: string): GateWeakeningCheck {
  const reasons: string[] = [];
  const { hunks } = parseUnifiedDiff(diff);
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (!line.startsWith("-")) continue;
      const text = line.slice(1).trim();
      if (!text) continue;
      if (GATE_TOKENS.test(text) || PROTECTIVE_TOKENS.test(text)) {
        reasons.push(`removes: ${text.slice(0, 120)}`);
      }
    }
  }
  return { flagged: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// The pipeline: propose → approval row → (human decision) → apply
// ---------------------------------------------------------------------------

export interface SkillDiffPayload {
  kind: "skill.modify";
  /** Repo-relative path (forward slashes) under an allow root. */
  targetPath: string;
  diff: string;
  rationale: string;
  /** Run id(s) that motivated the change — §7.3 requires provenance on every proposal. */
  runIds: string[];
  /** sha256 of the target as it existed at propose time ("" for a new file). The executor
   *  refuses to apply over a drifted base — what was reviewed is what gets applied. */
  baseHash: string;
  agent?: string;
  gateWeakening: boolean;
  gateWeakeningReasons: string[];
}

export interface SkillDiffPipelineConfig<TApproval extends BaseApproval> {
  /** Repo root the targetPath is relative to (the monorepo checkout holding skills/sops/souls). */
  repoRoot: string;
  approvals: Collection<TApproval>;
  buildRow: ProposalScaffoldConfig<SkillDiffPayload, TApproval>["buildRow"];
  allowRoots?: string[];
  denyPatterns?: RegExp[];
  /**
   * Applies the approved new text. PRODUCTION MUST SUPPLY the git-committing writer (branch,
   * commit message = rationale + run ids, merge) — the default is a plain tmp+rename write.
   */
  applyWrite?: (absPath: string, newText: string, payload: SkillDiffPayload) => Promise<{ ok: boolean; note: string }>;
  newId?: () => string;
}

export type ProposeDiffResult<TApproval> =
  | { ok: true; approval: TApproval; gateWeakening: boolean }
  | { ok: false; denied: string };

export interface SkillDiffPipeline<TApproval extends BaseApproval> {
  propose(input: {
    targetPath: string;
    diff: string;
    rationale: string;
    runIds?: string[];
    agent?: string;
  }): Promise<ProposeDiffResult<TApproval>>;
  /** Execute approved-but-unapplied rows. Call from the agent's scheduler, same as proposals. */
  scanAndExecute(): Promise<string>;
  decode(approval: TApproval): SkillDiffPayload | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function defaultApplyWrite(absPath: string, newText: string): Promise<{ ok: boolean; note: string }> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(`${absPath}.tmp`, newText, "utf8");
  await fs.rename(`${absPath}.tmp`, absPath);
  return { ok: true, note: `applied to ${absPath} (plain write — wire the git-committing writer for production)` };
}

export function createSkillDiffPipeline<TApproval extends BaseApproval>(
  cfg: SkillDiffPipelineConfig<TApproval>,
): SkillDiffPipeline<TApproval> {
  const applyWrite = cfg.applyWrite ?? defaultApplyWrite;
  const absTarget = (relPath: string): string => path.join(cfg.repoRoot, relPath);

  const scaffold = createProposalScaffold<SkillDiffPayload, TApproval>({
    prefix: "<<SKDF>>",
    approvals: cfg.approvals,
    buildRow: cfg.buildRow,
    newId: cfg.newId,
    describe: (p) =>
      `${p.gateWeakening ? "[GATE-WEAKENING] " : ""}skill.modify ${p.targetPath} — ${p.rationale.slice(0, 140)}`,
    executors: {
      "skill.modify": async (payload) => {
        // Re-validate at execute time, not just at propose: the approval row lives in a
        // Collection-backed store a UI can edit between propose and execute, and a tampered
        // targetPath like "../../src/authority/tiers.ts" would escape repoRoot via path.join
        // and defeat the deny list — the module header's hard rule.
        const recheck = checkDiffTarget(payload.targetPath, {
          allowRoots: cfg.allowRoots,
          denyPatterns: cfg.denyPatterns,
        });
        if (!recheck.allowed) return { ok: false, note: `refused at execute time: ${recheck.reason}` };
        const abs = absTarget(payload.targetPath);
        const current = await fs.readFile(abs, "utf8").catch(() => "");
        if (sha256(current) !== payload.baseHash) {
          return { ok: false, note: "base drifted since proposal — the reviewed diff no longer applies; re-propose" };
        }
        let next: string;
        try {
          next = applyUnifiedDiff(current, payload.diff);
        } catch (e) {
          return { ok: false, note: `diff failed to apply: ${e instanceof Error ? e.message : String(e)}` };
        }
        return applyWrite(abs, next, payload);
      },
    },
  });

  return {
    decode: scaffold.decode,

    async propose(input) {
      const targetPath = input.targetPath.replace(/\\/g, "/");
      const check = checkDiffTarget(targetPath, { allowRoots: cfg.allowRoots, denyPatterns: cfg.denyPatterns });
      if (!check.allowed) return { ok: false, denied: check.reason! };
      if (!input.rationale?.trim()) return { ok: false, denied: "a rationale is required on every skill diff" };

      let parsed: ParsedDiff;
      try {
        parsed = parseUnifiedDiff(input.diff);
      } catch (e) {
        return { ok: false, denied: `not a valid unified diff: ${e instanceof Error ? e.message : String(e)}` };
      }
      // A headered diff must agree with the declared target — a mismatch is either confusion or
      // an attempt to slip a second file past the deny check.
      if (parsed.target && parsed.target !== targetPath) {
        return { ok: false, denied: `diff header targets "${parsed.target}" but the proposal declares "${targetPath}"` };
      }

      const current = await fs.readFile(absTarget(targetPath), "utf8").catch(() => "");
      const weakening = detectGateWeakening(input.diff);
      const payload: SkillDiffPayload = {
        kind: "skill.modify",
        targetPath,
        diff: input.diff,
        rationale: input.rationale.trim(),
        runIds: input.runIds ?? [],
        baseHash: sha256(current),
        agent: input.agent,
        gateWeakening: weakening.flagged,
        gateWeakeningReasons: weakening.reasons,
      };
      const approval = await scaffold.propose({
        action: `${weakening.flagged ? "[GATE-WEAKENING] " : ""}skill.modify: ${targetPath}`,
        payload,
        // Never auto-approved (§7.3): high risk keeps it out of every agent's auto-approve band.
        risk: weakening.flagged ? "critical" : "high",
        dedupeRef: `skilldiff:${targetPath}:${sha256(input.diff)}`,
      });
      return { ok: true, approval, gateWeakening: weakening.flagged };
    },

    scanAndExecute: () => scaffold.scanAndExecute(),
  };
}
