// Tests for the shared intent loop.
//
// These exist because the loop is the safety-critical part and, until callModel became injectable,
// the only way to exercise it was a live API key and a real mailbox. Everything that decides
// whether the owner's world changes — the block gate, the approval gate, the reversible override,
// the voice deferral, and the three anti-lying defences — is checked here against a scripted model.
//
// Run: npm test  (inside AGENTOS-CORE)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runIntentLoop, claimsCompletion, anthropicStreamingCaller, anthropicCaller, lmStudioCaller, withNotes,
  IMAGE_GUIDANCE, sanitizeImages, imageDimensions, MAX_IMAGES, MAX_TOTAL_BASE64, MAX_IMAGE_SIDE,
  type IntentAdapter, type IntentContextBase, type IntentToolDef, type ContentBlock, type IntentGate,
} from "./index";

interface Ctx extends IntentContextBase { principal: string }

/** A model that emits a fixed script: one array of ContentBlocks per turn. */
function scriptedModel(turns: ContentBlock[][]) {
  let i = 0;
  return async () => turns[Math.min(i++, turns.length - 1)] ?? [];
}

function toolCall(name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", id: `tu_${name}`, name, input };
}
function say(text: string): ContentBlock {
  return { type: "text", text };
}

interface Harness {
  adapter: IntentAdapter<Ctx, IntentToolDef<Ctx>>;
  ran: string[];
  queued: string[];
  logs: string[];
}

function harness(opts: {
  turns: ContentBlock[][];
  gate?: IntentGate;
  tools?: Partial<IntentToolDef<Ctx>>[];
}): Harness {
  const ran: string[] = [];
  const queued: string[] = [];
  const logs: string[] = [];

  const defaults: Partial<IntentToolDef<Ctx>>[] = opts.tools ?? [
    { name: "read_thing", reversible: true, speed: "fast" },
    { name: "send_thing", reversible: false, speed: "fast" },
    { name: "slow_thing", reversible: true, speed: "slow" },
  ];

  const tools: IntentToolDef<Ctx>[] = defaults.map((t) => ({
    name: t.name!,
    description: t.description ?? `does ${t.name}`,
    input_schema: { type: "object", properties: {} },
    reversible: t.reversible ?? true,
    speed: t.speed ?? "fast",
    describe: () => `describe ${t.name}`,
    run: t.run ?? (async () => { ran.push(t.name!); return { ok: true, line: `${t.name}: real result` }; }),
  }));

  return {
    ran, queued, logs,
    adapter: {
      agent: "test",
      tools,
      systemPrompt: () => "sys",
      callModel: scriptedModel(opts.turns),
      gate: async () => opts.gate ?? { decision: "run" },
      queueApproval: async (tool) => { queued.push(tool.name); return { code: "AB12" }; },
      log: async (what) => { logs.push(what); },
    },
  };
}

const ctx: Ctx = { principal: "jordan", source: "sms" };

test("a reversible tool runs; the model reads its result and the owner gets the model's words, not the dump", async () => {
  const seen: unknown[] = [];
  const h = harness({ turns: [[toolCall("read_thing")], [say("You've got two emails to answer.")]] });
  const model = h.adapter.callModel;
  h.adapter.callModel = async (input) => { seen.push(JSON.stringify(input.messages)); return model(input); };
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.deepEqual(h.ran, ["read_thing"]);
  assert.deepEqual(h.queued, []);
  assert.match(String(seen.at(-1)), /read_thing: real result/, "the model must see the real result");
  assert.equal(out.reply, "You've got two emails to answer.");
  assert.equal(out.failed, false);
});

test("out of turns mid-research: one more tools-off turn writes the answer; raw results never reach the owner", async () => {
  const choices: (string | undefined)[] = [];
  const h = harness({ turns: [[toolCall("read_thing")], [toolCall("read_thing")], [say("Three things need you: A, B and C.")]] });
  h.adapter.maxTurns = 2;
  const model = h.adapter.callModel;
  h.adapter.callModel = async (input) => { choices.push(input.toolChoice); return model(input); };
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.deepEqual(choices, [undefined, undefined, "none"]);
  assert.equal(out.reply, "Three things need you: A, B and C.");
  assert.doesNotMatch(out.reply, /real result/);
});

test("the shared reply style is appended to every agent's system prompt", async () => {
  let sys = "";
  const h = harness({ turns: [[say("hi")]] });
  const model = h.adapter.callModel;
  h.adapter.callModel = async (input) => { sys = input.system; return model(input); };
  await runIntentLoop(text(), ctx, h.adapter);
  assert.match(sys, /^sys\n\n/);
  assert.match(sys, /Never paste raw tool output/);
});

test("an irreversible tool is QUEUED, never run, even when the gate says run", async () => {
  const h = harness({ turns: [[toolCall("send_thing")], [say("ok")]], gate: { decision: "run" } });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  // This is the override that matters: the agent's own authority table said yes, and the tool's
  // own irreversibility still wins.
  assert.deepEqual(h.ran, [], "an irreversible tool must not execute");
  assert.deepEqual(h.queued, ["send_thing"]);
  assert.match(out.reply, /Waiting on your OK before I describe send_thing — not done yet\./);
  assert.doesNotMatch(out.reply, /QUEUED|send_thing:/, "no raw status lines");
});

test("an irreversible tool RUNS when the gate says run with force (adapter vouches)", async () => {
  const h = harness({ turns: [[toolCall("send_thing")], [say("ok")]], gate: { decision: "run", force: true } });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.deepEqual(h.ran, ["send_thing"], "force lets the adapter's authority model waive the approval row");
  assert.deepEqual(h.queued, []);
  assert.ok(h.logs.some((l) => /gate\.force/.test(l)), "the waiver is logged");
  assert.equal(out.reply, "ok");
});

test("gate 'approve' queues even a reversible tool", async () => {
  const h = harness({ turns: [[toolCall("read_thing")], [say("ok")]], gate: { decision: "approve" } });
  await runIntentLoop(text(), ctx, h.adapter);
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.queued, ["read_thing"]);
});

test("gate 'block' neither runs nor queues, and says why", async () => {
  const h = harness({ turns: [[toolCall("read_thing")], [say("ok")]], gate: { decision: "block", reason: "tier 3" } });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.queued, [], "a blocked tool must not become an approval either");
  assert.match(out.reply, /I'm not allowed to describe read_thing \(tier 3\)\./);
});

test("voice defers slow tools instead of hanging the call", async () => {
  const deferred: string[] = [];
  const h = harness({ turns: [[toolCall("slow_thing")], [say("ok")]] });
  const voiceCtx: Ctx = { ...ctx, source: "voice", deferSlow: (t) => { deferred.push((t as IntentToolDef<Ctx>).name); } };
  const out = await runIntentLoop(text(), voiceCtx, h.adapter);
  assert.deepEqual(deferred, ["slow_thing"]);
  assert.deepEqual(h.ran, [], "a deferred tool must not also run inline");
  assert.match(out.reply, /I'll text you the result/);
});

test("approval beats deferral — a slow irreversible tool queues rather than starting", async () => {
  const deferred: string[] = [];
  const h = harness({
    turns: [[toolCall("slow_send")], [say("ok")]],
    tools: [{ name: "slow_send", reversible: false, speed: "slow" }],
  });
  const voiceCtx: Ctx = { ...ctx, source: "voice", deferSlow: (t) => { deferred.push((t as IntentToolDef<Ctx>).name); } };
  await runIntentLoop(text(), voiceCtx, h.adapter);
  assert.deepEqual(deferred, [], "asking by phone must not silently start an irreversible action");
  assert.deepEqual(h.queued, ["slow_send"]);
});

test("Defence C: a completion claim with no tool calls is replaced", async () => {
  // The exact sentence that shipped.
  const h = harness({ turns: [[say("Inbox swept; junk archived and labeled. All clear.")]] });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.doesNotMatch(out.reply, /Inbox swept/, "the false claim must not reach the owner");
  assert.match(out.reply, /I haven't touched anything/);
  assert.ok(h.logs.some((l) => l.includes("BLOCKED a completion claim")));
});

test("Defence B: a failure survives the model contradicting it, in plain words", async () => {
  const h = harness({
    turns: [[toolCall("failing")], [say("All sorted, nothing to worry about.")]],
    tools: [{ name: "failing", reversible: true, speed: "fast", run: async () => ({ ok: false, line: "failing: FAILED — token expired" }) }],
  });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.match(out.reply, /Heads up: describe failing didn't go through \(token expired\)\./, "ground truth must be in the message the owner reads");
});

test("a tool that throws is reported, not swallowed", async () => {
  const h = harness({
    turns: [[toolCall("boom")], [say("ok")]],
    tools: [{ name: "boom", reversible: true, speed: "fast", run: async () => { throw new Error("kaboom"); } }],
  });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.match(out.reply, /didn't go through \(.*kaboom\)/);
});

test("a model failure returns failed:true and never invents prose", async () => {
  const h = harness({ turns: [[]] });
  h.adapter.callModel = async () => { throw new Error("Anthropic 500"); };
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.equal(out.failed, true);
  assert.match(out.reply, /Nothing was changed/);
  assert.ok(h.logs.some((l) => l.includes("intent router failed")));
});

test("an unknown tool name does not crash the turn", async () => {
  const h = harness({ turns: [[toolCall("does_not_exist")], [say("I can't do that.")]] });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.equal(out.failed, false);
  assert.deepEqual(h.ran, []);
});

test("preflight can refuse before the model is called", async () => {
  let called = false;
  const h = harness({ turns: [[toolCall("read_thing")]] });
  h.adapter.callModel = async () => { called = true; return []; };
  h.adapter.preflight = async () => ({ reply: "staying local" });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.equal(called, false, "preflight must short-circuit before anything is sent to the model");
  assert.equal(out.reply, "staying local");
  assert.equal(out.clarifying, true);
});

test("clarifying is set for a question and a refusal, not for ordinary prose", async () => {
  const q = await runIntentLoop(text(), ctx, harness({ turns: [[say("Which 3pm did you mean?")]] }).adapter);
  assert.equal(q.clarifying, true);
  const r = await runIntentLoop(text(), ctx, harness({ turns: [[say("I can't do that yet.")]] }).adapter);
  assert.equal(r.clarifying, true);
  const p = await runIntentLoop(text(), ctx, harness({ turns: [[say("There are 42 unread.")]] }).adapter);
  assert.equal(p.clarifying, false, "ordinary prose should fall through to the caller's own path");
});

test("the loop stops at maxTurns instead of spinning", async () => {
  let calls = 0;
  const h = harness({ turns: [[toolCall("read_thing")]] });
  const inner = h.adapter.callModel;
  h.adapter.callModel = async (i) => { calls++; return inner(i); };
  h.adapter.maxTurns = 3;
  await runIntentLoop(text(), ctx, h.adapter);
  // Three tool turns, then one tools-off answer turn; a tool_use the model emits anyway never runs.
  assert.equal(calls, 4);
  assert.equal(h.ran.length, 3);
});

test("ctx.history is prepended before the live turn, empty turns dropped", async () => {
  let seen: unknown[] = [];
  const h = harness({ turns: [[say("ok")]] });
  const inner = h.adapter.callModel;
  h.adapter.callModel = async (i) => { seen = i.messages; return inner(i); };
  await runIntentLoop(text(), {
    ...ctx,
    history: [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "   " }, // must be dropped — the API rejects empty content
    ],
  }, h.adapter);
  assert.deepEqual(seen, [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: text() },
  ]);
});

test("history is sanitized: leading assistant dropped, same-role runs merged, trailing user folded", async () => {
  let seen: unknown[] = [];
  const h = harness({ turns: [[say("ok")]] });
  const inner = h.adapter.callModel;
  h.adapter.callModel = async (i) => { seen = i.messages; return inner(i); };
  await runIntentLoop(text(), {
    ...ctx,
    history: [
      { role: "assistant", content: "window opened mid-conversation" }, // must not lead — API requires user first
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a1 error row" }, // consecutive same-role — API rejects
      { role: "user", content: "q2" },                // trailing user — live turn folds in
    ],
  }, h.adapter);
  assert.deepEqual(seen, [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1\na1 error row" },
    { role: "user", content: `q2\n${text()}` },
  ]);
});

test("anthropicStreamingCaller emits deltas and reassembles blocks (incl. tool_use json)", async () => {
  const sse = [
    `data: {"type":"message_start"}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"read_thing","input":{}}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":": 1}"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_stop"}`,
  ].join("\n\n") + "\n\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    const tokens: string[] = [];
    const call = anthropicStreamingCaller("key", (t) => tokens.push(t));
    const blocks = await call({ system: "s", tools: [], messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(tokens, ["Hel", "lo"]);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: "text", text: "Hello" });
    assert.equal(blocks[1].type, "tool_use");
    assert.equal(blocks[1].name, "read_thing");
    assert.deepEqual(blocks[1].input, { a: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("claimsCompletion catches claims and allows offers", () => {
  for (const s of [
    "Inbox swept; junk archived and labeled. All clear.",
    "Done — I've archived the junk.",
    "Deployed it.",
    "Paused the campaign.",
  ]) assert.ok(claimsCompletion(s), `should catch: ${s}`);

  for (const s of [
    "Want me to clean up your inbox?",
    "I can deploy that if you like.",
    "Shall I pause it?",
    "There are 42 unread.",
  ]) assert.ok(!claimsCompletion(s), `should allow: ${s}`);
});

function text(): string { return "do the thing"; }

// ── sanitizeAssistantContent — replayed turns must be valid Anthropic content ────────────────────
import { sanitizeAssistantContent } from "./index";

test("sanitizeAssistantContent drops empty/whitespace text blocks", () => {
  const out = sanitizeAssistantContent([
    { type: "text", text: "" },
    { type: "text", text: "  \n" },
    { type: "text", text: "kept" },
    { type: "tool_use", id: "toolu_1", name: "x", input: {} },
  ]);
  assert.deepEqual(out.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(out[0].text, "kept");
});

test("sanitizeAssistantContent rewrites tool_use ids the API would reject, keeps valid ones", () => {
  const out = sanitizeAssistantContent([
    { type: "tool_use", id: "cli:1", name: "x", input: {} },
    { type: "tool_use", id: "cli_17_0", name: "y", input: {} },
    { type: "tool_use", name: "z", input: {} },
  ]);
  for (const b of out) assert.match(String(b.id), /^[a-zA-Z0-9_-]+$/);
  assert.equal(out[1].id, "cli_17_0");
});

test("the loop pairs tool_result with the sanitized id", async () => {
  const seen: unknown[][] = [];
  let turn = 0;
  const adapter = {
    agent: "t",
    tools: [{ name: "lookup", description: "d", input_schema: { type: "object" }, reversible: true, speed: "fast", describe: () => "lookup", run: async () => ({ ok: true, line: "found" }) }],
    callModel: async (input: { messages: unknown[] }) => {
      seen.push(JSON.parse(JSON.stringify(input.messages)));
      return turn++ === 0
        ? [{ type: "text", text: "" }, { type: "tool_use", id: "bad:id", name: "lookup", input: {} }]
        : [{ type: "text", text: "done" }];
    },
    systemPrompt: async () => "s",
    gate: async () => ({ decision: "run" as const }),
    queueApproval: async () => ({ code: "x" }),
    log: async () => {},
  };
  await runIntentLoop("find it", { principal: "p", source: "chat" } as Ctx, adapter as unknown as IntentAdapter<Ctx, IntentToolDef<Ctx>>);
  const replay = seen[1] as { role: string; content: { type: string; id?: string; tool_use_id?: string; text?: string }[] }[];
  const asst = replay[1].content;
  const result = replay[2].content[0];
  assert.ok(!asst.some((b) => b.type === "text" && !b.text), "no empty text block replayed");
  assert.equal(result.tool_use_id, asst.find((b) => b.type === "tool_use")!.id);
  assert.match(String(result.tool_use_id), /^[a-zA-Z0-9_-]+$/);
});

test("a reply that already owns up to a failure gets no duplicate note", async () => {
  const h = harness({
    turns: [[toolCall("failing")], [say("I couldn't get into your inbox — the token expired.")]],
    tools: [{ name: "failing", reversible: true, speed: "fast", run: async () => ({ ok: false, line: "failing: FAILED — token expired" }) }],
  });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.equal(out.reply, "I couldn't get into your inbox — the token expired.");
});

test("an empty closing turn after a pre-tool 'let me check' gets the answer-now turn, not the stale line", async () => {
  const h = harness({ turns: [[say("Let me check."), toolCall("read_thing")], [], [say("Two emails need replies.")]] });
  const out = await runIntentLoop(text(), ctx, h.adapter);
  assert.equal(out.reply, "Two emails need replies.");
});

test("two failures and a reply naming one: both are still disclosed", () => {
  const r = withNotes("I couldn't reach your calendar.", [
    { kind: "failed", what: "Read calendar", detail: "timeout" },
    { kind: "failed", what: "Send the recap", detail: "token expired" },
  ]);
  assert.match(r, /Send the recap didn't go through \(token expired\)/);
  assert.match(r, /Read calendar didn't go through/);
});

test("LM Studio: the answer-now turn keeps its tool results (tool messages first, then the text)", async (t) => {
  let sent: { messages?: { role: string; content: unknown; tool_call_id?: string }[]; tool_choice?: string } = {};
  t.mock.method(globalThis, "fetch", async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
  });
  await lmStudioCaller("http://lm.local/v1", "m")({
    system: "sys",
    tools: [{ name: "read_thing", description: "d", input_schema: { type: "object" } }],
    toolChoice: "none",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_thing", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "read_thing: real result" }, { type: "text", text: "answer now" }] as never },
    ],
  });
  const tail = (sent.messages ?? []).slice(-2);
  assert.deepEqual(tail.map((m) => m.role), ["tool", "user"]);
  assert.equal(tail[0].tool_call_id, "tu_1");
  assert.equal(tail[0].content, "read_thing: real result");
  assert.equal(tail[1].content, "answer now");
  assert.equal(sent.tool_choice, "none");
});

test("a completion claim never vouches for a queued action, even if another sentence mentions an OK", () => {
  const r = withNotes("I sent the report. Once you say yes, I can update the calendar.", [{ kind: "queued", what: "Send the report" }]);
  assert.match(r, /Waiting on your OK before I send the report — not done yet\./);
});

// ── Owner-attached images (2026-10-09) ──────────────────────────────────────────────────────────

// Real 3×2 images (Pillow), so the acceptance tests use complete files, not signature stubs.
const PNG_3X2 = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGOUqzjBwMDAwMDAxAADABguAWI2TQN8AAAAAElFTkSuQmCC";
const JPEG_3X2 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwClRRRXtHjn/9k=";
const GIF_3X2 = "R0lGODdhAwACAIEAAB54yAAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7";
const WEBP_LOSSLESS_3X2 = "UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQvHoUuf+BiOh/AAA=";
const WEBP_LOSSY_3X2 = "UklGRjgAAABXRUJQVlA4ICwAAACwAQCdASoDAAIAAsBMJaACdLoABDAAAP7l+j/4hzoc6HMxn/wrWet0aIgAAA==";
const WEBP_EXTENDED_3X2 = "UklGRkYAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAZGRkZGRkAFZQOCAYAAAAMAEAnQEqAwACAALATCWkAANwAP734IAA";

test("images reach Anthropic as image blocks on the live turn, and stay there across tool turns", async (t) => {
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  let n = 0;
  t.mock.method(globalThis, "fetch", async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const content = n++ === 0
      ? [{ type: "tool_use", id: "tu_1", name: "read_thing", input: {} }]
      : [{ type: "text", text: "That's a 500 from the API — restart the worker." }];
    return new Response(JSON.stringify({ content }));
  });
  const h = harness({ turns: [[]] });
  h.adapter.callModel = anthropicCaller("k", "claude-test");
  const out = await runIntentLoop("what's this?", { ...ctx, images: [{ mediaType: "image/png", dataBase64: PNG_3X2 }] }, h.adapter);
  assert.equal(out.reply, "That's a 500 from the API — restart the worker.");
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_3X2 } };
  assert.deepEqual(bodies[0].messages.at(-1), { role: "user", content: [image, { type: "text", text: "what's this?" }] });
  assert.deepEqual(bodies[1].messages[0].content, [image, { type: "text", text: "what's this?" }], "the image is still on the turn after a tool call");
});

test("LM Studio callers get the image as an OpenAI image_url part", async (t) => {
  let sent: { messages?: { role: string; content: unknown }[] } = {};
  t.mock.method(globalThis, "fetch", async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const h = harness({ turns: [[]] });
  h.adapter.callModel = lmStudioCaller("http://lm/v1", "qwen", 800);
  await runIntentLoop("what's this?", { ...ctx, images: [{ mediaType: "image/png", dataBase64: PNG_3X2 }] }, h.adapter);
  assert.deepEqual((sent.messages ?? []).at(-1)?.content, [
    { type: "text", text: "what's this?" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_3X2}` } },
  ]);
});

test("image guidance is only added when the turn has images; an image with no words still gets a text block", async () => {
  const systems: string[] = [];
  const msgs: unknown[] = [];
  const h = harness({ turns: [[say("ok")]] });
  const inner = h.adapter.callModel;
  h.adapter.callModel = async (i) => { systems.push(i.system); msgs.push(i.messages.at(-1)); return inner(i); };
  await runIntentLoop("hello", ctx, h.adapter);
  await runIntentLoop("", { ...ctx, images: [{ mediaType: "image/jpeg", dataBase64: JPEG_3X2 }] }, h.adapter);
  assert.ok(!systems[0].includes(IMAGE_GUIDANCE));
  assert.ok(systems[1].includes(IMAGE_GUIDANCE));
  assert.deepEqual(msgs[1], { role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_3X2 } },
    { type: "text", text: "(no message — just the image)" },
  ] });
});

test("sanitizeImages: keeps valid images (data: URLs too), drops bad types/data, caps the count", () => {
  assert.deepEqual(sanitizeImages([{ dataBase64: `data:image/png;base64,${PNG_3X2}` }]), [{ mediaType: "image/png", dataBase64: PNG_3X2 }]);
  assert.deepEqual(sanitizeImages([{ mediaType: "image/jpg", dataBase64: JPEG_3X2 }]), [{ mediaType: "image/jpeg", dataBase64: JPEG_3X2 }]);
  assert.deepEqual(sanitizeImages([{ mediaType: "application/pdf", dataBase64: PNG_3X2 }, { mediaType: "image/png", dataBase64: "not base64!" }, null, "x"]), []);
  assert.deepEqual(sanitizeImages("nope"), []);
  assert.equal(sanitizeImages(Array.from({ length: 9 }, () => ({ mediaType: "image/png", dataBase64: PNG_3X2 }))).length, MAX_IMAGES);
});

test("sanitizeImages rejects malformed base64 quanta and padding", () => {
  for (const bad of ["A", "AAA", "AAAA=", "AA=A", "AAAAA", "QQ=", "=AAA"]) {
    assert.deepEqual(sanitizeImages([{ mediaType: "image/png", dataBase64: bad }]), [], bad);
  }
  // Padding is fine when the bytes really are an image (both fixtures end in "=").
  assert.deepEqual(sanitizeImages([{ mediaType: "image/webp", dataBase64: WEBP_LOSSLESS_3X2 }]), [{ mediaType: "image/webp", dataBase64: WEBP_LOSSLESS_3X2 }]);
  assert.deepEqual(sanitizeImages([{ mediaType: "image/jpeg", dataBase64: JPEG_3X2 }]), [{ mediaType: "image/jpeg", dataBase64: JPEG_3X2 }]);
});

test("sanitizeImages rejects an oversized payload from its length alone", (t) => {
  const decode = t.mock.method(Buffer, "from");
  const huge = "A".repeat(Math.ceil((5 * 1024 * 1024 + 3) / 3) * 4);
  assert.deepEqual(sanitizeImages([{ mediaType: "image/png", dataBase64: huge }]), []);
  assert.equal(decode.mock.callCount(), 0, "never decoded");
});

test("runIntentLoop applies the image limits itself: count cap, bad data and bad types never reach the model", async () => {
  let seen: unknown[] = [];
  const h = harness({ turns: [[say("ok")]] });
  const inner = h.adapter.callModel;
  h.adapter.callModel = async (i) => { seen = i.messages; return inner(i); };
  const many = Array.from({ length: 6 }, () => ({ mediaType: "image/png", dataBase64: PNG_3X2 }));
  await runIntentLoop("look", { ...ctx, images: [{ mediaType: "image/png", dataBase64: "A" }, { mediaType: "text/html", dataBase64: PNG_3X2 }, ...many] }, h.adapter);
  const live = seen.at(-1) as { content: { type: string }[] };
  assert.equal(live.content.filter((b) => b.type === "image").length, MAX_IMAGES);
});

test("sanitizeImages: the bytes must match the declared type (magic bytes), for every supported type", () => {
  const ok = [["image/png", PNG_3X2], ["image/jpeg", JPEG_3X2], ["image/gif", GIF_3X2], ["image/webp", WEBP_LOSSLESS_3X2], ["image/webp", WEBP_LOSSY_3X2], ["image/webp", WEBP_EXTENDED_3X2]];
  for (const [mediaType, dataBase64] of ok) assert.equal(sanitizeImages([{ mediaType, dataBase64 }]).length, 1, mediaType);
  // Valid base64, wrong content: plain text, or a real JPEG declared as PNG.
  assert.deepEqual(sanitizeImages([{ mediaType: "image/png", dataBase64: "QUJD" }]), []);
  assert.deepEqual(sanitizeImages([{ mediaType: "image/png", dataBase64: JPEG_3X2 }]), []);
  assert.deepEqual(sanitizeImages([{ mediaType: "image/webp", dataBase64: "UklGRgAAAABBVkkg" }]), [], "RIFF but AVI, not WEBP");
});

test("sanitizeImages: 5 MB decoded per image and a total cap across all images", () => {
  const png = (bytes: number) => pngBytes(3, 2, bytes).toString("base64");
  assert.equal(sanitizeImages([{ mediaType: "image/png", dataBase64: png(5 * 1024 * 1024) }]).length, 1, "exactly 5 MB is allowed");
  assert.equal(sanitizeImages([{ mediaType: "image/png", dataBase64: png(5 * 1024 * 1024 + 1) }]).length, 0);
  const four = Array.from({ length: 4 }, () => ({ mediaType: "image/png", dataBase64: png(5 * 1024 * 1024) }));
  const kept = sanitizeImages(four);
  assert.ok(kept.reduce((n, i) => n + i.dataBase64.length, 0) <= MAX_TOTAL_BASE64);
  assert.equal(kept.length, 2, "four 5 MB images (~6.7 MB encoded each) stop at the 20 MB total");
});

/** A structurally complete PNG (signature, IHDR, optional padding chunk, IEND) of an exact size. */
function pngBytes(width: number, height: number, totalBytes = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // CRC isn't checked
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const head = Buffer.concat([sig, chunk("IHDR", ihdr)]);
  const end = chunk("IEND", Buffer.alloc(0));
  const pad = totalBytes ? totalBytes - head.length - end.length - 12 : -1;
  return Buffer.concat([head, ...(pad >= 0 ? [chunk("tEXt", Buffer.alloc(pad))] : []), end]);
}

test("sanitizeImages: a signature alone, a truncated file or the wrong container is not an image", () => {
  const cut = (b64: string, keep: number) => Buffer.from(b64, "base64").subarray(0, keep).toString("base64");
  const bad: Array<[string, string]> = [
    ["image/png", "iVBORw0KGgo="],                      // signature only
    ["image/png", cut(PNG_3X2, 40)],                    // IHDR but no IEND (truncated upload)
    ["image/jpeg", "/9j/4A=="],                         // SOI only
    ["image/jpeg", cut(JPEG_3X2, 300)],                 // cut mid-file: no end-of-image marker
    ["image/gif", "R0lGODlh"],                          // header only
    ["image/gif", cut(GIF_3X2, 30)],                    // no trailer
    ["image/webp", "UklGRgAAAABXRUJQ"],                 // RIFF/WEBP with no chunk
    ["image/webp", cut(WEBP_LOSSY_3X2, 40)],            // RIFF size says more bytes than there are
  ];
  for (const [mediaType, dataBase64] of bad) assert.deepEqual(sanitizeImages([{ mediaType, dataBase64 }]), [], `${mediaType} ${dataBase64.slice(0, 16)}`);
});

test("imageDimensions reads the real size for every supported format", () => {
  const dims = (b64: string, type: string) => imageDimensions(Buffer.from(b64, "base64"), type);
  for (const [b64, type] of [[PNG_3X2, "image/png"], [JPEG_3X2, "image/jpeg"], [GIF_3X2, "image/gif"], [WEBP_LOSSLESS_3X2, "image/webp"], [WEBP_LOSSY_3X2, "image/webp"], [WEBP_EXTENDED_3X2, "image/webp"]]) {
    assert.deepEqual(dims(b64, type), { width: 3, height: 2 }, type);
  }
  assert.equal(dims(PNG_3X2, "image/jpeg"), null, "declared type must match the bytes");
});

test("sanitizeImages enforces the provider's pixel limit on either side, and rejects zero", () => {
  const png = (w: number, h: number) => pngBytes(w, h).toString("base64");
  assert.equal(sanitizeImages([{ mediaType: "image/png", dataBase64: png(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE) }]).length, 1, "exactly the limit is fine");
  assert.deepEqual(sanitizeImages([{ mediaType: "image/png", dataBase64: png(MAX_IMAGE_SIDE + 1, 10) }]), []);
  assert.deepEqual(sanitizeImages([{ mediaType: "image/png", dataBase64: png(10, MAX_IMAGE_SIDE + 1) }]), []);
  assert.deepEqual(sanitizeImages([{ mediaType: "image/png", dataBase64: png(0, 10) }]), []);
});
