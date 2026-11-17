import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Collection } from "../store";
import type { BaseApproval } from "../proposals";
import {
  applyUnifiedDiff,
  parseUnifiedDiff,
  checkDiffTarget,
  detectGateWeakening,
  createSkillDiffPipeline,
} from "./index";

// ---------------------------------------------------------------------------
// applyUnifiedDiff
// ---------------------------------------------------------------------------

const ORIGINAL = "line one\nline two\nline three\nline four";

const EDIT_DIFF = [
  "--- a/skills/x/SKILL.md",
  "+++ b/skills/x/SKILL.md",
  "@@ -1,4 +1,4 @@",
  " line one",
  "-line two",
  "+line 2 improved",
  " line three",
  " line four",
].join("\n");

test("applies a well-formed diff; strict about drifted context", () => {
  assert.equal(applyUnifiedDiff(ORIGINAL, EDIT_DIFF), "line one\nline 2 improved\nline three\nline four");
  assert.throws(() => applyUnifiedDiff("totally different\ncontent", EDIT_DIFF), /does not apply/);
  assert.throws(() => applyUnifiedDiff(ORIGINAL, "no hunks here"), /no hunks/);
});

test("new-file diffs apply to empty content and refuse a non-empty target", () => {
  const newFile = ["--- /dev/null", "+++ b/skills/y/SKILL.md", "@@ -0,0 +1,2 @@", "+first", "+second"].join("\n");
  assert.equal(applyUnifiedDiff("", newFile), "first\nsecond");
  assert.throws(() => applyUnifiedDiff("existing", newFile), /already has content/);
  assert.equal(parseUnifiedDiff(newFile).isNewFile, true);
  assert.equal(parseUnifiedDiff(newFile).target, "skills/y/SKILL.md");
});

test("multi-hunk diffs apply in order; out-of-order hunks refuse", () => {
  const twoHunks = [
    "@@ -1,2 +1,2 @@",
    "-line one",
    "+ONE",
    " line two",
    "@@ -4,1 +4,2 @@",
    "-line four",
    "+line four",
    "+line five",
  ].join("\n");
  assert.equal(applyUnifiedDiff(ORIGINAL, twoHunks), "ONE\nline two\nline three\nline four\nline five");

  const overlapping = ["@@ -3,1 +3,1 @@", "-line three", "+3", "@@ -1,1 +1,1 @@", "-line one", "+1"].join("\n");
  assert.throws(() => applyUnifiedDiff(ORIGINAL, overlapping), /overlap|out of order/);
});

// ---------------------------------------------------------------------------
// Deny list
// ---------------------------------------------------------------------------

test("deny list: authority/config/boundary paths are unreachable, allow roots bound everything else", () => {
  assert.equal(checkDiffTarget("skills/pitch-deck/SKILL.md").allowed, true);
  assert.equal(checkDiffTarget("sops/deploy-verify.md").allowed, true);
  assert.equal(checkDiffTarget("souls/clara/learned.md").allowed, true);
  assert.equal(checkDiffTarget("souls/friday/subagents/builder.md").allowed, true);

  for (const denied of [
    "souls/constitution.md",
    "souls/clara/persona.md",
    "souls/evals/persona.evals.yaml",
    "skills/anything/../../src/authority/tiers.ts", // traversal
    "src/authority/tiers.ts", // outside allow roots
    "src/config/owner.ts",
    "C:/abs/path.md",
  ]) {
    const check = checkDiffTarget(denied);
    assert.equal(check.allowed, false, `${denied} must be denied`);
    assert.ok(check.reason, "denial carries a reason");
  }

  // Deny wins even when a caller widens the allow roots over a safety path.
  const widened = checkDiffTarget("src/authority/tiers.ts", { allowRoots: ["src/"] });
  assert.equal(widened.allowed, false);
  assert.match(widened.reason!, /deny list/);
});

// ---------------------------------------------------------------------------
// Gate-weakening detection
// ---------------------------------------------------------------------------

test("gate-weakening flags removed protective language; pure additions never flag", () => {
  const weakening = [
    "@@ -1,3 +1,2 @@",
    " intro",
    "-    gate: approval",
    "+    gate: none",
    " outro",
  ].join("\n");
  const w = detectGateWeakening(weakening);
  assert.equal(w.flagged, true);
  assert.match(w.reasons[0], /gate: approval/);

  const tightening = ["@@ -1,1 +1,2 @@", " intro", "+Never send without approval."].join("\n");
  assert.equal(detectGateWeakening(tightening).flagged, false);

  const benign = ["@@ -1,2 +1,2 @@", "-Use blue in the header.", "+Use teal in the header.", " body"].join("\n");
  assert.equal(detectGateWeakening(benign).flagged, false);

  const removesRefusal = ["@@ -1,1 +0,0 @@", "-You must not publish without review."].join("\n");
  assert.equal(detectGateWeakening(removesRefusal).flagged, true);
});

// ---------------------------------------------------------------------------
// Pipeline end-to-end
// ---------------------------------------------------------------------------

async function makePipeline() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skilldiff-repo-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "skilldiff-data-"));
  await fs.mkdir(path.join(repoRoot, "skills", "x"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "skills", "x", "SKILL.md"), ORIGINAL);
  const approvals = new Collection<BaseApproval>(dataDir, "approvals");
  const pipeline = createSkillDiffPipeline<BaseApproval>({
    repoRoot,
    approvals,
    buildRow: (core) => core,
  });
  return { repoRoot, approvals, pipeline };
}

test("propose → approve → apply lands the new text; unapproved rows never apply", async () => {
  const { repoRoot, approvals, pipeline } = await makePipeline();
  const res = await pipeline.propose({
    targetPath: "skills/x/SKILL.md",
    diff: EDIT_DIFF,
    rationale: "run showed the old phrasing produced weak output",
    runIds: ["job_123"],
    agent: "friday",
  });
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.gateWeakening, false);
  assert.equal(res.approval.status, "pending");
  assert.equal(res.approval.risk, "high");
  const payload = pipeline.decode(res.approval)!;
  assert.equal(payload.targetPath, "skills/x/SKILL.md");
  assert.deepEqual(payload.runIds, ["job_123"]);

  // Not approved yet — nothing applies, file untouched.
  assert.equal(await pipeline.scanAndExecute(), "nothing to execute");
  assert.equal(await fs.readFile(path.join(repoRoot, "skills", "x", "SKILL.md"), "utf8"), ORIGINAL);

  await approvals.update(res.approval.id, { status: "approved" });
  assert.match(await pipeline.scanAndExecute(), /executed 1, failed 0/);
  assert.equal(
    await fs.readFile(path.join(repoRoot, "skills", "x", "SKILL.md"), "utf8"),
    "line one\nline 2 improved\nline three\nline four",
  );
});

test("propose refuses deny-listed targets, missing rationale, and header/target mismatch", async () => {
  const { pipeline } = await makePipeline();

  const denied = await pipeline.propose({ targetPath: "souls/constitution.md", diff: EDIT_DIFF, rationale: "r" });
  assert.ok(!denied.ok && /deny list/.test(denied.denied));

  const noRationale = await pipeline.propose({ targetPath: "skills/x/SKILL.md", diff: EDIT_DIFF, rationale: "  " });
  assert.ok(!noRationale.ok && /rationale/.test(noRationale.denied));

  const mismatch = await pipeline.propose({ targetPath: "skills/other/SKILL.md", diff: EDIT_DIFF, rationale: "r" });
  assert.ok(!mismatch.ok && /declares/.test(mismatch.denied));
});

test("gate-weakening proposals are badged in the action and escalated to critical", async () => {
  const { repoRoot, pipeline } = await makePipeline();
  await fs.mkdir(path.join(repoRoot, "sops"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "sops", "deploy.md"), "step:\n    gate: approval\ndone");
  const res = await pipeline.propose({
    targetPath: "sops/deploy.md",
    diff: ["@@ -1,3 +1,3 @@", " step:", "-    gate: approval", "+    gate: none", " done"].join("\n"),
    rationale: "deploys are slow",
  });
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.gateWeakening, true);
  assert.match(res.approval.action, /^\[GATE-WEAKENING\] /);
  assert.equal(res.approval.risk, "critical");
  assert.ok(pipeline.decode(res.approval)!.gateWeakeningReasons.length > 0);
});

test("executor refuses to apply over a drifted base", async () => {
  const { repoRoot, approvals, pipeline } = await makePipeline();
  const res = await pipeline.propose({ targetPath: "skills/x/SKILL.md", diff: EDIT_DIFF, rationale: "r" });
  assert.ok(res.ok);
  if (!res.ok) return;
  await approvals.update(res.approval.id, { status: "approved" });

  // The file moves under the proposal before the executor runs.
  await fs.writeFile(path.join(repoRoot, "skills", "x", "SKILL.md"), "someone edited this meanwhile");
  assert.match(await pipeline.scanAndExecute(), /executed 0, failed 1/);
  const after = await approvals.get(res.approval.id);
  assert.match(after!.resultNote!, /base drifted/);
  assert.equal(await fs.readFile(path.join(repoRoot, "skills", "x", "SKILL.md"), "utf8"), "someone edited this meanwhile");
});
