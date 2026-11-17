import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { VaultWriter } from "./index";

test("write creates a dated markdown file with frontmatter and never overwrites", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  const v = new VaultWriter({ vaultPath: root });

  const f1 = await v.write({ section: "runs", title: "Test Run!", body: "body one", meta: { agent: "clara" } });
  const f2 = await v.write({ section: "runs", title: "Test Run!", body: "body two" });
  assert.notEqual(f1, f2); // collision suffixed, not overwritten

  const text = await fs.readFile(f1, "utf8");
  assert.match(text, /^---\n/);
  assert.match(text, /title: "Test Run!"/);
  assert.match(text, /agent: "clara"/);
  assert.match(text, /body one/);
  // date-bucketed: section/YYYY-MM/YYYY-MM-DD title.md
  assert.match(path.relative(root, f1).replace(/\\/g, "/"), /^runs\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2} test-run\.md$/);
});

test("writeTranscript renders turns and lands in meetings/ for meetings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  const v = new VaultWriter({ vaultPath: root });
  const f = await v.writeTranscript({
    kind: "meeting",
    title: "Standup",
    participants: ["jordan", "clara", "friday"],
    turns: [
      { speaker: "jordan", text: "status?" },
      { speaker: "clara", text: "calendar clean, sir." },
    ],
  });
  const text = await fs.readFile(f, "utf8");
  assert.match(text, /participants: \["jordan", "clara", "friday"\]/);
  assert.match(text, /\*\*clara\*\*/);
  assert.ok(path.relative(root, f).replace(/\\/g, "/").startsWith("meetings/"));
});
