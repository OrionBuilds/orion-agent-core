// Tests for the durable work queue — the properties that make overnight unattended operation
// safe: claims are exclusive, dead workers' jobs are swept correctly (partial-deliver vs requeue
// vs fail), and the attempt ceiling actually stops a poisoned job.
//
// Run: npm test (inside AGENTOS-CORE)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkQueue, type Job } from "./index";

async function tmpQueue(): Promise<{ q: WorkQueue; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wq-"));
  return { q: new WorkQueue({ dataDir: root }), root };
}

test("enqueue → claimNext claims oldest and bumps attempts", async () => {
  const { q } = await tmpQueue();
  const a = await q.enqueue({ agent: "clara", kind: "deepwork", payload: { task: "A" } });
  await q.enqueue({ agent: "clara", kind: "deepwork", payload: { task: "B" } });
  const claimed = await q.claimNext();
  assert.equal(claimed?.id, a.id);
  assert.equal(claimed?.state, "claimed");
  assert.equal(claimed?.attempts, 1);
  assert.equal(claimed?.claimedByPid, process.pid);
});

test("notBefore defers a job until its time", async () => {
  const { q } = await tmpQueue();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await q.enqueue({ agent: "clara", kind: "deepwork", payload: {}, notBefore: future });
  assert.equal(await q.claimNext(), null);
  assert.notEqual(await q.claimNext(new Date(Date.now() + 7_200_000)), null);
});

test("complete ok=false below the ceiling re-queues; at the ceiling fails", async () => {
  const { q } = await tmpQueue();
  const job = await q.enqueue({ agent: "clara", kind: "deepwork", payload: {}, maxAttempts: 2 });
  await q.claimNext();
  await q.complete(job.id, { ok: false, result: "attempt 1 broke" });
  assert.equal((await q.get(job.id))?.state, "queued");
  await q.claimNext();
  await q.complete(job.id, { ok: false, result: "attempt 2 broke" });
  const final = await q.get(job.id);
  assert.equal(final?.state, "failed");
  assert.equal(final?.attempts, 2);
});

test("partial outcomes finish the job as done+partial, never retried", async () => {
  const { q } = await tmpQueue();
  const job = await q.enqueue({ agent: "clara", kind: "deepwork", payload: {} });
  await q.claimNext();
  await q.complete(job.id, { ok: false, partial: true, result: "stalled but 2 files delivered" });
  const final = await q.get(job.id);
  assert.equal(final?.state, "done");
  assert.equal(final?.partial, true);
});

async function plantDeadClaim(q: WorkQueue, root: string, opts: { withOutput: boolean; attempts?: number; maxAttempts?: number }): Promise<Job> {
  const job = await q.enqueue({ agent: "clara", kind: "deepwork", payload: {}, maxAttempts: opts.maxAttempts ?? 2 });
  const ws = path.join(root, "ws", job.id);
  await fs.mkdir(path.join(ws, "output"), { recursive: true });
  if (opts.withOutput) await fs.writeFile(path.join(ws, "output", "report.pdf"), "x", "utf8");
  // Forge the on-disk state a crashed worker leaves behind: running, dead pid, workspace set.
  const raw = JSON.parse(await fs.readFile(path.join(root, "workqueue", "jobs", `${job.id}.json`), "utf8")) as Job;
  raw.state = "running";
  raw.claimedByPid = 999_999_999; // no such pid
  raw.workspace = ws;
  raw.attempts = opts.attempts ?? 1;
  await fs.writeFile(path.join(root, "workqueue", "jobs", `${job.id}.json`), JSON.stringify(raw), "utf8");
  return raw;
}

test("sweep: dead worker + deliverables → done(partial), not re-run", async () => {
  const { q, root } = await tmpQueue();
  const job = await plantDeadClaim(q, root, { withOutput: true });
  const res = await q.sweep();
  assert.equal(res.partials.length, 1);
  assert.equal((await q.get(job.id))?.state, "done");
  assert.equal((await q.get(job.id))?.partial, true);
});

test("sweep: dead worker + nothing produced → re-queued below ceiling, failed at it", async () => {
  const { q, root } = await tmpQueue();
  const a = await plantDeadClaim(q, root, { withOutput: false, attempts: 1 });
  const b = await plantDeadClaim(q, root, { withOutput: false, attempts: 2 });
  const res = await q.sweep();
  assert.equal(res.requeued.length, 1);
  assert.equal(res.failed.length, 1);
  assert.equal((await q.get(a.id))?.state, "queued");
  assert.equal((await q.get(b.id))?.state, "failed");
});

test("sweep leaves live claims alone", async () => {
  const { q } = await tmpQueue();
  const job = await q.enqueue({ agent: "clara", kind: "deepwork", payload: {} });
  await q.claimNext(); // claimed by OUR live pid
  const res = await q.sweep();
  assert.equal(res.requeued.length + res.partials.length + res.failed.length, 0);
  assert.equal((await q.get(job.id))?.state, "claimed");
});

test("worker lock is exclusive and breakable only when the holder is dead", async () => {
  const { q, root } = await tmpQueue();
  assert.equal(await q.acquireLock(), true);
  assert.equal(await q.acquireLock(), true); // re-entrant for our own pid
  // Forge a dead holder and confirm a new queue instance can break in.
  await fs.writeFile(path.join(root, "workqueue", "worker.lock", "pid"), "999999999", "utf8");
  const q2 = new WorkQueue({ dataDir: root });
  assert.equal(await q2.acquireLock(), true);
  await q2.releaseLock();
});

test("cancel stops queued/claimed jobs but never rewrites finished ones", async () => {
  const { q } = await tmpQueue();
  const job = await q.enqueue({ agent: "clara", kind: "deepwork", payload: {} });
  await q.cancel(job.id);
  assert.equal((await q.get(job.id))?.state, "cancelled");
  const done = await q.enqueue({ agent: "clara", kind: "deepwork", payload: {} });
  await q.claimNext();
  await q.complete(done.id, { ok: true, result: "delivered" });
  await q.cancel(done.id);
  assert.equal((await q.get(done.id))?.state, "done");
});
