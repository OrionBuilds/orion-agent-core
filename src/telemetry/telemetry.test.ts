import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ToolTelemetry } from "./index";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "telemetry-test-"));
}

test("wrap records success, tool-level failure, and thrown failure", async () => {
  const t = new ToolTelemetry({ dataDir: await tmp(), agent: "clara" });

  const good = t.wrap("good_tool", async (x: number) => ({ ok: true, value: x * 2 }));
  assert.deepEqual(await good(21), { ok: true, value: 42 });

  const toolLevelFail = t.wrap("meh_tool", async () => ({ ok: false, line: "nope" }));
  await toolLevelFail();

  const thrower = t.wrap("bad_tool", async () => {
    throw new Error("kaboom");
  });
  await assert.rejects(thrower, /kaboom/);

  const stats = await t.stats();
  assert.equal(stats["good_tool"]?.calls, 1);
  assert.equal(stats["good_tool"]?.failures, 0);
  assert.equal(stats["meh_tool"]?.failures, 1);
  assert.equal(stats["bad_tool"]?.failures, 1);
  assert.equal(stats["bad_tool"]?.successRate, 0);
});

test("stats respects the time window", async () => {
  const dir = await tmp();
  const t = new ToolTelemetry({ dataDir: dir, agent: "friday" });
  // Write an old record directly into the stream
  const old = { ts: new Date(Date.now() - 48 * 3600_000).toISOString(), agent: "friday", tool: "ancient", ok: true, latencyMs: 5 };
  await fs.appendFile(path.join(dir, "tool-telemetry.jsonl"), JSON.stringify(old) + "\n");
  await t.record({ tool: "fresh", ok: true, latencyMs: 3 });

  const day = await t.stats(24 * 3600_000);
  assert.equal(day["ancient"], undefined);
  assert.equal(day["fresh"]?.calls, 1);
});

test("record never throws even on an unwritable dir", async () => {
  // "Z:/..." is only unwritable on Windows — on POSIX it's a relative path that mkdir happily
  // creates under cwd, so the swallow path never ran and the test littered the working directory.
  // A regular file can't be a parent directory, so mkdir fails with ENOTDIR on every platform.
  const blocker = path.join(await tmp(), "not-a-dir");
  await fs.writeFile(blocker, "x");
  const t = new ToolTelemetry({ dataDir: path.join(blocker, "nested"), agent: "x" });
  await t.record({ tool: "t", ok: true, latencyMs: 1 }); // must not reject
});
