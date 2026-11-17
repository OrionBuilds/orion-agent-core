// Tests for the sub-agent pool — the property that matters is CONTAINMENT: a sub-agent can never
// reach beyond parent ∩ subset, and everything that gates inherits from the parent unchanged.
//
// Run: npm test (inside AGENTOS-CORE)

import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeTools, subAgentAdapter, runSubAgent, type SubAgentDef } from "./index";
import type { IntentAdapter, IntentContextBase, IntentToolDef, ContentBlock } from "../intent";

interface Ctx extends IntentContextBase { principal: string }

function tool(name: string, run?: () => Promise<{ ok: boolean; line: string }>): IntentToolDef<Ctx> {
  return {
    name,
    description: `does ${name}`,
    input_schema: { type: "object", properties: {} },
    reversible: true,
    speed: "fast",
    describe: () => name,
    run: run ?? (async () => ({ ok: true, line: `${name}: ran` })),
  };
}

const DEF: SubAgentDef = { id: "front-desk", name: "Front Desk", parent: "clara", description: "leads", tools: ["read_a", "not_in_parent"] };

function parentAdapter(turns: ContentBlock[][], onQueue?: (name: string) => void): IntentAdapter<Ctx, IntentToolDef<Ctx>> {
  let i = 0;
  return {
    agent: "clara",
    tools: [tool("read_a"), tool("read_b"), tool("send_x")],
    systemPrompt: () => "PARENT PROMPT",
    callModel: async () => turns[Math.min(i++, turns.length - 1)] ?? [],
    gate: async () => ({ decision: "run" }),
    queueApproval: async (t) => { onQueue?.(t.name); return { code: "AB12" }; },
    log: async () => {},
  };
}

test("scopeTools is a strict intersection — subset names outside the parent vanish", () => {
  const scoped = scopeTools([tool("read_a"), tool("read_b")], ["read_a", "not_in_parent"]);
  assert.deepEqual(scoped.map((t) => t.name), ["read_a"]);
});

test("subAgentAdapter carries only the intersected tools and a namespaced identity", () => {
  const sub = subAgentAdapter(parentAdapter([]), DEF, "SOUL");
  assert.equal(sub.agent, "clara:front-desk");
  assert.deepEqual(sub.tools.map((t) => t.name), ["read_a"]);
});

test("the soul leads the prompt and the parent prompt survives at the tail", async () => {
  const sub = subAgentAdapter(parentAdapter([]), DEF, "I AM THE FRONT DESK");
  const prompt = await sub.systemPrompt({ principal: "jordan", source: "chat" });
  assert.ok(prompt.startsWith("I AM THE FRONT DESK"));
  assert.ok(prompt.includes("PARENT PROMPT"));
  assert.ok(prompt.includes("SUB-AGENT CONTEXT"));
});

test("a sub-run executes an in-scope tool through the loop", async () => {
  const turns: ContentBlock[][] = [
    [{ type: "tool_use", id: "t1", name: "read_a", input: {} }],
    [{ type: "text", text: "done" }],
  ];
  const out = await runSubAgent("do it", { principal: "jordan", source: "chat" }, parentAdapter(turns), DEF, "SOUL");
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].name, "read_a");
  assert.equal(out.calls[0].ok, true);
});

test("an out-of-scope tool (in parent, NOT in subset) is unreachable from a sub-run", async () => {
  const turns: ContentBlock[][] = [
    [{ type: "tool_use", id: "t1", name: "send_x", input: {} }],
    [{ type: "text", text: "hm" }],
  ];
  const out = await runSubAgent("send it", { principal: "jordan", source: "chat" }, parentAdapter(turns), DEF, "SOUL");
  // The loop reports it as "no such tool" — nothing ran.
  assert.equal(out.calls.length, 0);
});

test("parent gates inherit — an approve gate queues from inside the sub-run", async () => {
  const queued: string[] = [];
  const parent = parentAdapter(
    [[{ type: "tool_use", id: "t1", name: "read_a", input: {} }], [{ type: "text", text: "ok" }]],
    (name) => queued.push(name),
  );
  parent.gate = async () => ({ decision: "approve" });
  const out = await runSubAgent("do it", { principal: "jordan", source: "chat" }, parent, DEF, "SOUL");
  assert.deepEqual(queued, ["read_a"]);
  assert.equal(out.calls[0].ok, false); // queued, not run — the parent's approval rail, unchanged
});
