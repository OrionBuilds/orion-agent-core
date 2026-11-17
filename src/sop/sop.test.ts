import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadSops,
  listSopsFor,
  loadSop,
  renderSopChecklist,
  recordSopRun,
  listSopRuns,
} from "./index";

const GOOD_SOP = `---
id: client.onboarding.v1
name: New client onboarding
owner: clara
trigger: { event: deal.won }
steps:
  - id: contract_send
    run: docusign.send
    gate: approval
    on_fail: escalate
    sla: 4h
  - id: drive_folders
    run: drive.folder_create
    agent: friday
  - id: kickoff
    run: calendar.book
    gate: approval
escalation: Page the owner by SMS if the contract is unsigned after 3 days.
---
Body text describing the procedure.
`;

const ALL_SOP = `---
id: approval.escalation.v1
name: Approval escalation
owner: all
trigger: { event: approval.stale }
steps:
  - id: nudge
    run: notify.sms
---
`;

async function makeSopsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sop-test-"));
  await fs.writeFile(path.join(dir, "client-onboarding.md"), GOOD_SOP);
  await fs.writeFile(path.join(dir, "approval-escalation.md"), ALL_SOP);
  await fs.writeFile(path.join(dir, "README.md"), "not an SOP");
  return dir;
}

test("loads SOPs with defaults (gate none, on_fail escalate); README skipped", async () => {
  const dir = await makeSopsDir();
  const { sops, invalid } = await loadSops(dir);
  assert.deepEqual(invalid, []);
  assert.deepEqual(sops.map((s) => s.id).sort(), ["approval.escalation.v1", "client.onboarding.v1"]);
  const onboarding = sops.find((s) => s.id === "client.onboarding.v1")!;
  assert.equal(onboarding.owner, "clara");
  assert.deepEqual(onboarding.trigger, { event: "deal.won" });
  assert.equal(onboarding.steps[0].gate, "approval");
  assert.equal(onboarding.steps[0].sla, "4h");
  assert.equal(onboarding.steps[1].gate, "none");
  assert.equal(onboarding.steps[1].onFail, "escalate");
  assert.equal(onboarding.steps[1].agent, "friday");
  assert.match(onboarding.body, /Body text/);
  assert.match(onboarding.hash, /^[0-9a-f]{64}$/);
});

test("malformed SOPs surface in invalid[], never silently drop or half-parse", async () => {
  const dir = await makeSopsDir();
  await fs.writeFile(path.join(dir, "broken-no-steps.md"), "---\nid: x.v1\nname: X\nowner: clara\n---\n");
  await fs.writeFile(
    path.join(dir, "broken-bad-gate.md"),
    "---\nid: y.v1\nname: Y\nowner: clara\nsteps:\n  - id: a\n    run: t\n    gate: sometimes\n---\n",
  );
  await fs.writeFile(
    path.join(dir, "broken-dupe-step.md"),
    "---\nid: z.v1\nname: Z\nowner: clara\nsteps:\n  - id: a\n    run: t\n  - id: a\n    run: u\n---\n",
  );
  const { sops, invalid } = await loadSops(dir);
  assert.equal(sops.length, 2);
  assert.equal(invalid.length, 3);
  assert.ok(invalid.some((i) => /steps must be a non-empty list/.test(i.reason)));
  assert.ok(invalid.some((i) => /unknown gate "sometimes"/.test(i.reason)));
  assert.ok(invalid.some((i) => /duplicate step id "a"/.test(i.reason)));
});

test("listSopsFor returns the agent's own plus owner:all; loadSop finds by id", async () => {
  const dir = await makeSopsDir();
  const clara = await listSopsFor(dir, "clara");
  assert.deepEqual(clara.map((s) => s.id).sort(), ["approval.escalation.v1", "client.onboarding.v1"]);
  const friday = await listSopsFor(dir, "friday");
  assert.deepEqual(friday.map((s) => s.id), ["approval.escalation.v1"]);
  assert.equal((await loadSop(dir, "client.onboarding.v1"))?.name, "New client onboarding");
  assert.equal(await loadSop(dir, "nope"), null);
});

test("checklist renders ordered steps with gates, cross-agent routing, SLA and escalation", async () => {
  const dir = await makeSopsDir();
  const sop = (await loadSop(dir, "client.onboarding.v1"))!;
  const text = renderSopChecklist(sop);
  assert.match(text, /^SOP: New client onboarding \(client\.onboarding\.v1\) — owner: clara/);
  assert.match(text, /TRIGGER: event=deal\.won/);
  assert.match(text, /never execute it directly/);
  assert.match(text, /1\. \[contract_send\] run docusign\.send — gate: approval; on fail: escalate; SLA 4h/);
  assert.match(text, /2\. \[drive_folders\] run drive\.folder_create via friday — gate: none/);
  assert.match(text, /ESCALATION: Page the owner by SMS/);
});

test("audit: a fully-done run records followed:true; deviations and omissions record honestly", async () => {
  const sopsDir = await makeSopsDir();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sop-audit-"));
  const sop = (await loadSop(sopsDir, "client.onboarding.v1"))!;

  const clean = await recordSopRun(
    dataDir,
    {
      sopId: sop.id,
      agent: "clara",
      steps: [
        { id: "contract_send", status: "done" },
        { id: "drive_folders", status: "done" },
        { id: "kickoff", status: "done" },
      ],
    },
    sop,
  );
  assert.equal(clean.followed, true);
  assert.deepEqual(clean.deviations, []);
  assert.equal(clean.sopHash, sop.hash);

  const dirty = await recordSopRun(
    dataDir,
    {
      sopId: sop.id,
      agent: "clara",
      runId: "job_abc",
      steps: [
        { id: "contract_send", status: "done" },
        { id: "drive_folders", status: "skipped", note: "folders already existed" },
      ],
    },
    sop,
  );
  assert.equal(dirty.followed, false);
  assert.equal(dirty.deviations.length, 2); // the skip + the unrecorded kickoff step
  assert.match(dirty.deviations[0], /\[drive_folders\] skipped: folders already existed/);
  assert.match(dirty.deviations[1], /\[kickoff\] not recorded/);

  const runs = await listSopRuns(dataDir, { sopId: sop.id });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, dirty.id, "newest first");
});

test("audit: an empty step list never audits as followed", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sop-audit-empty-"));
  const rec = await recordSopRun(dataDir, { sopId: "x.v1", agent: "clara", steps: [] });
  assert.equal(rec.followed, false);
});
