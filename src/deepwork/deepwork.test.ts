import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runDeepWork } from "./index";

// A stand-in "claude" binary: a shim that ignores the real CLI flags, swallows stdin (the brief
// arrives there), and replays a canned stream-json session — two assistant messages carrying
// tool_use blocks, then a result frame. This exercises the real spawn → stream-parse → collect
// path, including the §12 tool-usage capture, without a live CLI session.
async function makeStubBin(dir: string): Promise<string> {
  const stubJs = path.join(dir, "stub.js");
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Starting research." },
          { type: "tool_use", name: "Read" },
          { type: "tool_use", name: "Bash" },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read" },
          { type: "tool_use", name: "mcp__orion__contacts_list" },
        ],
      },
    },
    { type: "result", result: "SUMMARY: did the thing.\nFILES: none\nNEEDS YOUR ATTENTION: None.", total_cost_usd: 0.12 },
  ];
  await fs.writeFile(
    stubJs,
    [
      "const lines = " + JSON.stringify(lines.map((l) => JSON.stringify(l))) + ";",
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => {",
      "  for (const l of lines) process.stdout.write(l + '\\n');",
      "  process.exit(0);",
      "});",
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    const cmd = path.join(dir, "stub.cmd");
    await fs.writeFile(cmd, `@node "%~dp0stub.js"\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(dir, "stub.sh");
  await fs.writeFile(sh, `#!/bin/sh\nexec node "$(dirname "$0")/stub.js"\n`, "utf8");
  await fs.chmod(sh, 0o755);
  return sh;
}

test("captures per-run tool usage from the stream and persists it beside the run", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepwork-stub-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepwork-data-"));
  const bin = await makeStubBin(binDir);

  const events: string[] = [];
  const result = await runDeepWork({
    agent: "clara",
    dataDir,
    task: "test task",
    bin,
    timeoutMs: 30_000,
    stallMs: 0,
    onEvent: (l) => events.push(l),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true, "canned session with a SUMMARY report must succeed");
  assert.match(result.summary, /SUMMARY: did the thing\./);
  assert.equal(result.costUsd, 0.12);

  // The instrument step: counts by stream name, MCP tools under their full names.
  assert.deepEqual(result.toolUsage, { Read: 2, Bash: 1, "mcp__orion__contacts_list": 1 });

  // Evidence persists on disk for cross-run aggregation.
  const onDisk = JSON.parse(await fs.readFile(path.join(result.workspace, "tool-usage.json"), "utf8"));
  assert.deepEqual(onDisk, result.toolUsage);

  // Tool activity still reaches the activity feed.
  assert.ok(events.includes("[Read]"));
  assert.ok(events.includes("[mcp__orion__contacts_list]"));
});

test("a session that never calls a tool records an empty usage map, not a missing one", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepwork-stub2-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepwork-data2-"));
  const stubJs = path.join(binDir, "stub.js");
  await fs.writeFile(
    stubJs,
    [
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => {",
      `  process.stdout.write(JSON.stringify({ type: 'result', result: 'SUMMARY: chat only.' }) + '\\n');`,
      "  process.exit(0);",
      "});",
    ].join("\n"),
    "utf8",
  );
  let bin: string;
  if (process.platform === "win32") {
    bin = path.join(binDir, "stub.cmd");
    await fs.writeFile(bin, `@node "%~dp0stub.js"\r\n`, "utf8");
  } else {
    bin = path.join(binDir, "stub.sh");
    await fs.writeFile(bin, `#!/bin/sh\nexec node "$(dirname "$0")/stub.js"\n`, "utf8");
    await fs.chmod(bin, 0o755);
  }

  const result = await runDeepWork({ agent: "friday", dataDir, task: "t", bin, timeoutMs: 30_000, stallMs: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.toolUsage, {});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.workspace, "tool-usage.json"), "utf8")), {});
});
