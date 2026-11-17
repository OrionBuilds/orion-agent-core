import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Collection } from "../store";
import { createProposalScaffold, type BaseApproval } from "./index";

type Payload = { kind: "note"; text: string } | { kind: "boom"; text: string };

async function makeScaffold() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proposals-test-"));
  const approvals = new Collection<BaseApproval>(dir, "approvals");
  const executed: string[] = [];
  const scaffold = createProposalScaffold<Payload, BaseApproval>({
    prefix: "<<TEST>>",
    approvals,
    executors: {
      note: async (p) => {
        executed.push(p.text);
        return { ok: true, note: `noted: ${p.text}` };
      },
      boom: async () => {
        throw new Error("executor exploded");
      },
    },
    buildRow: (core) => core,
  });
  return { approvals, scaffold, executed };
}

test("propose creates a pending row with an encoded payload", async () => {
  const { approvals, scaffold } = await makeScaffold();
  const row = await scaffold.propose({ action: "write a note", payload: { kind: "note", text: "hi" } });
  assert.equal(row.status, "pending");
  assert.ok(row.detail?.includes("<<TEST>>"));
  assert.deepEqual(scaffold.decode(row), { kind: "note", text: "hi" });
  assert.equal((await approvals.all()).length, 1);
});

test("pending rows are not executed; approved rows execute exactly once", async () => {
  const { approvals, scaffold, executed } = await makeScaffold();
  const row = await scaffold.propose({ action: "n", payload: { kind: "note", text: "once" } });

  assert.equal(await scaffold.scanAndExecute(), "nothing to execute");
  assert.equal(executed.length, 0);

  await approvals.update(row.id, { status: "approved", decidedAt: new Date().toISOString() });
  assert.match(await scaffold.scanAndExecute(), /executed 1, failed 0/);
  assert.deepEqual(executed, ["once"]);

  // Second scan: the stamped row must not re-fire.
  assert.equal(await scaffold.scanAndExecute(), "nothing to execute");
  assert.deepEqual(executed, ["once"]);

  const after = await approvals.get(row.id);
  assert.ok(after?.executedAt);
  assert.equal(after?.resultNote, "noted: once");
});

test("a throwing executor stamps FAILED and does not retry", async () => {
  const { approvals, scaffold } = await makeScaffold();
  const row = await scaffold.propose({ action: "b", payload: { kind: "boom", text: "x" } });
  await approvals.update(row.id, { status: "approved" });
  assert.match(await scaffold.scanAndExecute(), /executed 0, failed 1/);
  const after = await approvals.get(row.id);
  assert.match(after?.resultNote ?? "", /^FAILED: Error: executor exploded/);
  assert.equal(await scaffold.scanAndExecute(), "nothing to execute");
});

test("dedupeRef returns the existing open row instead of double-proposing", async () => {
  const { approvals, scaffold } = await makeScaffold();
  const a = await scaffold.propose({ action: "n", payload: { kind: "note", text: "1" }, dedupeRef: "job:1" });
  const b = await scaffold.propose({ action: "n", payload: { kind: "note", text: "2" }, dedupeRef: "job:1" });
  assert.equal(a.id, b.id);
  assert.equal((await approvals.all()).length, 1);
});

test("rows belonging to a different prefix are never claimed", async () => {
  const { approvals, scaffold } = await makeScaffold();
  await approvals.insert({
    id: crypto.randomUUID(),
    action: "someone else's",
    detail: "other feature <<OTHER>>{}",
    risk: "low",
    status: "approved",
    requestedAt: new Date().toISOString(),
  });
  assert.equal(await scaffold.scanAndExecute(), "nothing to execute");
});
