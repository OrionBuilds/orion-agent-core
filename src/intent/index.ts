// Shared intent router — the JARVIS layer, for every agent.
//
// WHAT THIS REPLACES. Hand-written keyword parsers in a fixed order, each with its own grammar, and
// a conversational LLM at the bottom as the catch-all. The owner texted "Analyze my inbox and clean it up
// it's got a lot of junk in it"; the regex wanted the verb BEFORE the word inbox; it didn't match;
// the message fell through to the LLM; the LLM replied "Inbox swept; junk archived and labeled. All
// clear." The ledger shows zero action rows between the owner's text and that reply.
//
// Two problems, and the second is the one that matters:
//
//   1. Matching was keyword-brittle. Fixable by widening regexes, forever, one phrasing at a time.
//   2. The fallback could CLAIM WORK IT DID NOT DO. Not fixable by widening anything.
//
// This module fixes (1) by letting a model decide which capability is wanted, and (2) structurally:
// the model's only way to affect the world is to call a tool, and the sentence the owner reads is
// assembled from what those tools actually RETURNED. It is not asked to be honest about what it
// did — it is not given the option to be otherwise.
//
// Three defences, in order:
//
//   A. Tools or nothing. Actions exist only as tool handlers. There is no code path where model
//      prose causes a side effect.
//   B. Tool results are appended verbatim to the reply. If the model embellishes, the truth is in
//      the same message.
//   C. A post-check (claimsCompletion) catches past-tense completion language emitted with zero
//      tool calls and replaces it. A and B should make this unreachable; it exists because this
//      precise sentence is what shipped.
//
// WHY IT LIVES IN agent-core. CLARA proved the design; FRIDAY needs exactly the same
// guarantees over completely different tools. The loop, the gates and the three defences are
// identical for every agent — only the catalog, the persona and the authority model differ, and those
// are injected through IntentAdapter. Copying ~200 lines of safety-critical loop into each agent is how
// the agents' notify/outbound code drifted apart before agent-core existed.

import { sanitizeImages } from "./images";

/** Minimal shapes for the Anthropic tool-use wire format. Only the fields this loop reads. */
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** Anthropic image block payload (`type: "image"`). */
  source?: { type: "base64"; media_type: string; data: string };
}

/** An image the owner attached to the live turn (screenshot, photo). Base64, no data: prefix. */
export interface ImageInput {
  mediaType: string;
  dataBase64: string;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[] | ToolResultBlock[];
}

export interface IntentContextBase {
  /** Where the request arrived from — shapes length, not permissions. */
  source: "sms" | "chat" | "voice" | "email";
  /**
   * Prior turns of this conversation, oldest first. Optional because SMS/voice arrive one message
   * at a time; the web UIs hold a transcript. When present it is prepended to the model's messages
   * so "do that for the other one too" resolves — without it every router call is turn one.
   * Cap what you pass (the callers slice to ~10); this is context, not the durable record.
   */
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * Images attached to the LIVE turn only (history stays text). They ride on the user message as
   * Anthropic image blocks (OpenAI image_url parts if the turn goes to an LM Studio caller).
   */
  images?: ImageInput[];
  /**
   * Voice only. When set, `slow` tools are NOT run inline — they are handed to this callback to run
   * detached, and the router tells the caller it has started them.
   *
   * Without this a phone call goes silent for minutes and Twilio times the webhook out. With it,
   * "clean up my inbox" over the phone means the agent says it's on it, ends the turn, and texts the
   * real result when the work finishes.
   *
   * The tool parameter is typed `never` so each agent can narrow it to its OWN tool type (which
   * carries agent-specific fields like a tier category) without the base interface having to know
   * about them. Contravariance makes that narrowing legal; a concrete type here would not.
   */
  deferSlow?: (tool: never, args: Record<string, unknown>) => void;
}

export interface IntentToolDef<Ctx> {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  input_schema: Record<string, unknown>;
  /**
   * False = the effect reaches outside the company or cannot be undone (sending mail,
   * dialing a stranger, deploying, moving a meeting other people are attending, spending money).
   * Those never execute directly — they become an approval regardless of what the agent's own
   * authority model says, because those tables were written before this router existed and are not
   * a complete map of outbound risk.
   */
  reversible: boolean;
  /**
   * Roughly how long this takes, and it exists entirely for VOICE.
   *
   * A phone call cannot hold silence. A mailbox sweep runs for minutes; a caller hears dead air and
   * hangs up, and Twilio times the webhook out long before the tool returns. So voice runs `fast`
   * tools inline and speaks the answer, and for `slow` ones says it's starting and delivers the
   * result by text when it lands.
   *
   * SMS, email and the UI run everything inline; none of them are latency-bound. This is the one
   * property that differs per channel, which is why it lives on the tool rather than in the router.
   */
  speed: "fast" | "slow";
  /** Human-readable summary for the approval card when this needs one. */
  describe: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: Ctx) => Promise<{ ok: boolean; line: string }>;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  /** The tool's raw result line. The model reads it; the owner never sees it verbatim. */
  resultLine: string;
  ok: boolean;
}

export interface IntentOutcome {
  /** What to say back: the agent's own conversational answer, plus a plain note for anything that
   *  failed, was blocked, is waiting on the owner's OK, or was started in the background. */
  reply: string;
  calls: ToolCallRecord[];
  /** True when the router could not run at all — the caller must NOT paper over this. */
  failed: boolean;
  /**
   * True when no tool ran but the router still has something that must be said — a clarifying
   * question, or a refusal.
   *
   * Callers use this to decide whether to fall through to their own conversational path. Without
   * it, "which 3pm meeting did you mean?" would be computed and then silently thrown away by a
   * caller that only checks `calls.length`.
   */
  clarifying: boolean;
}

/** What the agent's own authority model says about running one tool right now. */
export type IntentGate =
  /**
   * `force: true` — the adapter vouches for running an IRREVERSIBLE tool without an approval row
   * (its own origin-aware authority model said so, e.g. owner/CLARA-originated non-money work).
   * Off by default: a plain `run` on an irreversible tool still queues, so agents that never set it
   * (CLARA) keep the original behaviour byte-for-byte.
   */
  | { decision: "run"; force?: true }
  | { decision: "approve" }
  | { decision: "block"; reason: string };

/**
 * Everything that differs between agents.
 *
 * Deliberately small. If something can be shared it belongs in the loop, not here — every method
 * added to this interface is a decision every agent now has to make separately.
 */
export interface IntentAdapter<Ctx extends IntentContextBase, T extends IntentToolDef<Ctx> = IntentToolDef<Ctx>> {
  /** "clara" | "friday". Used in log lines only. */
  agent: string;
  tools: T[];
  /** Tool → result → tool → result. Enough for "find the event, then move it"; not enough to loop. */
  maxTurns?: number;
  systemPrompt: (ctx: Ctx) => string | Promise<string>;
  /**
   * The model call, injected rather than hardcoded — which is what makes the gating loop testable
   * without a live API key or a bill. `anthropicCaller` below is the real one.
   */
  callModel: (input: { system: string; tools: { name: string; description: string; input_schema: Record<string, unknown> }[]; messages: AnthropicMessage[]; toolChoice?: "auto" | "none" }) => Promise<ContentBlock[]>;
  gate: (tool: T, ctx: Ctx) => Promise<IntentGate>;
  /**
   * Persist an approval row and return its short code. The code is an INTERNAL handle (dashboards,
   * logs, hidden reply back-compat): since 2026-09-24 the owner is asked in plain words and answers
   * in plain words (CLARA's decision rail), so the loop never shows the code to a person.
   */
  queueApproval: (tool: T, args: Record<string, unknown>, ctx: Ctx, requestText: string) => Promise<{ code: string }>;
  /** Structured log. Must never throw — the loop does not guard it beyond a catch. */
  log: (what: string, meta?: Record<string, unknown>) => Promise<void>;
  /**
   * Optional refusal BEFORE the model sees the text — e.g. CLARA's sensitivity screen, which keeps
   * private content on the local model rather than routing it through a hosted one.
   */
  preflight?: (text: string, ctx: Ctx) => Promise<{ reply: string } | null>;
}

// ── The completion-claim guard ──────────────────────────────────────────────────────────────────

/**
 * Does this text assert that an action was ALREADY carried out?
 *
 * Deliberately narrow: past-tense first-person claims about the verbs these agents' tools cover.
 * It is not trying to police tone, only the one sentence shape that caused this whole change —
 * "Inbox swept; junk archived and labeled. All clear." emitted with no work behind it.
 */
const COMPLETION_VERBS =
  "(?:swept|archived|cleaned|tidied|sorted|organi[sz]ed|deleted|sent|emailed|booked|scheduled|moved|cancelled|canceled|restarted|updated|added|created|filed|deployed|shipped|published|paused|launched)";
// The subject must be first-person — a free-floating verb match swallowed truthful third-party
// answers ("The campaign was paused by Meta.", "There are 3 drafts you sent last week.") and
// Defence C replaced them with "I haven't touched anything…", losing the real answer.
const FIRST_PERSON_CLAIM = new RegExp(`\\b(?:i|i've|i have|we|we've|we have)\\s+(?:just\\s+|already\\s+)?${COMPLETION_VERBS}\\b`);
// Telegraphic claims drop the subject ("Deployed it.", "Inbox swept; junk archived.") — allow the
// verb at a sentence start, or after at most a two-word topic, but never right after an auxiliary
// (that shape is passive reporting about someone ELSE's action, e.g. "Campaign was paused").
const TELEGRAPHIC_CLAIM = new RegExp(
  `(?:^|[.;:!?]\\s*|\\n\\s*)(?:[\\w'-]+\\s+){0,2}(?<!\\b(?:was|were|been|being|is|are|be|get|gets|got)\\s)${COMPLETION_VERBS}\\b`,
);

export function claimsCompletion(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (FIRST_PERSON_CLAIM.test(t) || TELEGRAPHIC_CLAIM.test(t)) &&
    !/\b(i can|i could|i'?ll|i will|want me to|shall i|should i|would you like)\b/.test(t)
  );
}

// ── The real model caller ───────────────────────────────────────────────────────────────────────

/**
 * Raw fetch rather than @anthropic-ai/sdk: every other Anthropic call across these three codebases
 * is a plain fetch, and one router is not worth adding a dependency the rest of the apps don't have.
 */
export function anthropicCaller(apiKey: string, model = "claude-sonnet-5", maxTokens = 1200) {
  return async (input: { system: string; tools: { name: string; description: string; input_schema: Record<string, unknown> }[]; messages: AnthropicMessage[]; toolChoice?: "auto" | "none" }): Promise<ContentBlock[]> => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: input.system, tools: input.tools, messages: input.messages, ...(input.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const res = await r.json() as { content?: ContentBlock[] };
    return res.content ?? [];
  };
}

/**
 * Streaming variant of `anthropicCaller` — same contract (resolves to the full ContentBlock[]), but
 * emits text deltas through `onToken` as they arrive, so a chat route can forward them to the
 * browser while the turn is still generating. Tool-use blocks are assembled from input_json_delta
 * frames and come back exactly as the non-streaming caller would return them, which is what lets
 * `runIntentLoop` stay completely unchanged: streaming is a property of the CALLER, not the loop.
 *
 * The deltas are provisional by design — on tool turns the loop may add a plain status note or a
 * final answer turn, which is not the concatenation of deltas. Consumers stream tokens for liveness and
 * replace the lot with the authoritative final message when the loop returns.
 */
export function anthropicStreamingCaller(
  apiKey: string,
  onToken: (text: string) => void,
  model = "claude-sonnet-5",
  maxTokens = 1200,
) {
  return async (input: { system: string; tools: { name: string; description: string; input_schema: Record<string, unknown> }[]; messages: AnthropicMessage[]; toolChoice?: "auto" | "none" }): Promise<ContentBlock[]> => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system: input.system, tools: input.tools, messages: input.messages, ...(input.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok || !r.body) throw new Error(`Anthropic ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);

    const blocks: ContentBlock[] = [];
    // Partial tool_use JSON accumulates per block index until content_block_stop.
    const partialJson = new Map<number, string>();
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const handle = (ev: { type?: string; index?: number; content_block?: ContentBlock; delta?: { type?: string; text?: string; partial_json?: string } }) => {
      if (ev.type === "content_block_start" && ev.content_block && typeof ev.index === "number") {
        blocks[ev.index] = ev.content_block.type === "tool_use"
          ? { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {} }
          : { type: "text", text: "" };
        if (ev.content_block.type === "tool_use") partialJson.set(ev.index, "");
      } else if (ev.type === "content_block_delta" && typeof ev.index === "number") {
        if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          const b = blocks[ev.index];
          if (b?.type === "text") b.text = (b.text ?? "") + ev.delta.text;
          try { onToken(ev.delta.text); } catch { /* a broken consumer must not kill the turn */ }
        } else if (ev.delta?.type === "input_json_delta" && typeof ev.delta.partial_json === "string") {
          partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + ev.delta.partial_json);
        }
      } else if (ev.type === "content_block_stop" && typeof ev.index === "number") {
        const pj = partialJson.get(ev.index);
        const b = blocks[ev.index];
        if (pj !== undefined && b?.type === "tool_use") {
          try { b.input = pj.trim() ? JSON.parse(pj) : {}; } catch { b.input = {}; }
          partialJson.delete(ev.index);
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames: lines, events separated by blank lines; we only need `data: {...}` lines.
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { handle(JSON.parse(payload)); } catch { /* keep-alives / partial lines are not fatal */ }
      }
    }
    return blocks.filter(Boolean);
  };
}

// ── LM Studio caller (2026-08-23 owner directive: local-first, Anthropic as fallback) ────────────
//
// LM Studio speaks OpenAI's chat-completions wire format, not Anthropic's — this caller's whole
// job is translating both directions so runIntentLoop, the gates and the three defences stay
// completely unaware which brain actually answered. The loop only ever sees ContentBlock[].

interface OpenAIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function toOpenAIMessages(system: string, messages: AnthropicMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as (ContentBlock | ToolResultBlock)[];
    const results = blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    if (results.length) {
      // Anthropic sends tool results back as one user-role message carrying N tool_result blocks
      // (plus, on the loop's answer-now turn, a text block); OpenAI wants one role:"tool" message
      // per result, then any extra user text after them.
      for (const b of results) {
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
      }
      const extra = (blocks as ContentBlock[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      if (extra) out.push({ role: "user", content: extra });
      continue;
    }
    const cb = blocks as ContentBlock[];
    const text = cb.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const toolUses = cb.filter((b) => b.type === "tool_use");
    const images = cb.filter((b) => b.type === "image" && b.source?.data);
    if (images.length && m.role === "user") {
      // OpenAI-style content parts: the text first, then each image as a data: URL.
      const parts: OpenAIContentPart[] = text ? [{ type: "text", text }] : [];
      for (const img of images) parts.push({ type: "image_url", image_url: { url: `data:${img.source!.media_type};base64,${img.source!.data}` } });
      out.push({ role: "user", content: parts });
      continue;
    }
    const msg: OpenAIMessage = { role: m.role, content: text || null };
    if (toolUses.length) {
      msg.tool_calls = toolUses.map((t) => ({
        id: String(t.id ?? ""),
        type: "function" as const,
        function: { name: String(t.name ?? ""), arguments: JSON.stringify(t.input ?? {}) },
      }));
    }
    out.push(msg);
  }
  return out;
}

function toOpenAITools(tools: { name: string; description: string; input_schema: Record<string, unknown> }[]) {
  return tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

function fromOpenAIMessage(msg: { content?: string | null; tool_calls?: OpenAIToolCall[] }): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {};
    try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
    blocks.push({ type: "tool_use", id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.function.name, input });
  }
  return blocks;
}

/**
 * Same contract as anthropicCaller — resolves to ContentBlock[] — but talks to LM Studio's
 * OpenAI-compatible /chat/completions instead. Caller resolves its own base URL/model (each app
 * has its own config path for that already); this function is agnostic of where those came from.
 */
export function lmStudioCaller(baseUrl: string, model: string, maxTokens = 1200) {
  return async (input: { system: string; tools: { name: string; description: string; input_schema: Record<string, unknown> }[]; messages: AnthropicMessage[]; toolChoice?: "auto" | "none" }): Promise<ContentBlock[]> => {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(input.system, input.messages),
        tools: input.tools.length ? toOpenAITools(input.tools) : undefined,
        tool_choice: input.tools.length && input.toolChoice === "none" ? "none" : undefined,
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`LM Studio ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const j = await r.json().catch(() => ({})) as { choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[] };
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new Error("LM Studio: no choices in response");
    return fromOpenAIMessage(msg);
  };
}

/**
 * Streaming variant. LM Studio's own SSE tool-call deltas are real but fiddly to accumulate
 * correctly across every quirk of every local model — rather than risk silently mis-assembling a
 * tool call (which for this router means a wrong real-world action), this calls the non-streaming
 * endpoint above and emits the whole answer as one onToken() frame once it lands. Callers get a
 * correct result with worse perceived latency, never a fast-but-wrong one. Same fallback contract
 * as anthropicStreamingCaller otherwise — resolves to the same ContentBlock[] shape.
 */
export function lmStudioStreamingCaller(
  baseUrl: string,
  onToken: (text: string) => void,
  model: string,
  maxTokens = 1200,
) {
  const nonStreaming = lmStudioCaller(baseUrl, model, maxTokens);
  return async (input: { system: string; tools: { name: string; description: string; input_schema: Record<string, unknown> }[]; messages: AnthropicMessage[]; toolChoice?: "auto" | "none" }): Promise<ContentBlock[]> => {
    const blocks = await nonStreaming(input);
    const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
    if (text) { try { onToken(text); } catch { /* a broken consumer must not kill the turn */ } }
    return blocks;
  };
}

// ── Reply shaping ───────────────────────────────────────────────────────────────────────────────

/** Appended to every agent's system prompt: how a reply should sound to the owner. */
export const REPLY_STYLE = [
  "How to answer:",
  "- Talk like a sharp assistant, not a log. Answer the question directly, in a few plain sentences.",
  "- Summarize what the tools found: counts, then only the handful of items that need attention (who, what, by when).",
  "- Never paste raw tool output, search queries, result lists, IDs, or field dumps. Skip noise (newsletters, your own automated mail) unless asked.",
  "- If nothing needs attention, say so in one sentence. If something failed or is waiting on an OK, say that plainly.",
  "- Offer one useful next step when there is one.",
].join("\n");

/** Appended to the system prompt only when the owner attached images to this turn. */
export const IMAGE_GUIDANCE = [
  "The owner attached image(s) to this message. Look at them before answering:",
  "- Say briefly what the image shows.",
  "- If it shows an error or a problem (a screenshot of a failure, a broken page, a warning), diagnose it and propose a concrete fix.",
  "- Use what's in the image to do what they asked.",
  "- If they gave no instructions with the image, ask one short follow-up about what they need you to do with it.",
].join("\n");

const ANSWER_NOW = "(No more tools this turn. Answer the owner now, in plain conversational words, from what you found — a short summary, not the raw results.)";

export interface CallNote { kind: "failed" | "blocked" | "queued" | "started"; what: string; detail?: string }

function describeSafe<Ctx>(def: IntentToolDef<Ctx>, args: Record<string, unknown>): string {
  try {
    const d = def.describe(args).trim();
    if (d) return d.replace(/[.\s]+$/, "");
  } catch { /* fall through */ }
  return def.name.replace(/_/g, " ");
}

/** "send_thing: FAILED — token expired" → "token expired". */
function failureDetail(line: string, name: string): string {
  const rest = line.startsWith(`${name}:`) ? line.slice(name.length + 1).trim() : line.trim();
  return rest.replace(/^FAILED\s*[—-]\s*/i, "").slice(0, 160);
}

const SAYS = {
  failed: /\b(fail|failed|couldn'?t|could not|didn'?t (go|work)|wasn'?t able|error|went wrong|not able)\b/i,
  blocked: /\b(blocked|not allowed|can'?t do that|policy|not permitted)\b/i,
  queued: /\b(your (ok|okay|approval|go-ahead)|approve|once you (say|confirm)|waiting on you|needs your)\b/i,
  started: /\b(started|kicked off|running in the background|text you|i'?ll (text|let you know))\b/i,
};

/** The reply plus one plain sentence per outcome the reply doesn't already own up to. */
export function withNotes(text: string, notes: CallNote[]): string {
  const extra: string[] = [];
  // Per sentence: claimsCompletion() exempts any text containing "I can"/"I'll", so one hedged
  // sentence would otherwise hide a false claim in the one before it.
  const claimed = text.split(/(?<=[.!?])\s+|\n+/).some((sentence) => claimsCompletion(sentence));
  const perKind = new Map<CallNote["kind"], number>();
  for (const n of notes) perKind.set(n.kind, (perKind.get(n.kind) ?? 0) + 1);
  for (const n of notes) {
    // A generic "couldn't" can only vouch for one outcome. With two failures and a reply that names
    // one, both are stated; better a repeat than a silent miss.
    // A reply that claims something was done never vouches for a not-done outcome: "I sent the
    // report. Once you say yes I'll move the meeting" must still say the report is waiting.
    const acknowledged = perKind.get(n.kind) === 1 && SAYS[n.kind].test(text) && !claimed;
    if (acknowledged) continue;
    if (n.kind === "failed") extra.push(`Heads up: ${n.what} didn't go through${n.detail ? ` (${n.detail})` : ""}.`);
    else if (n.kind === "blocked") extra.push(`I'm not allowed to ${lowerFirst(n.what)}${n.detail ? ` (${n.detail})` : ""}.`);
    else if (n.kind === "queued") extra.push(`Waiting on your OK before I ${lowerFirst(n.what)} — not done yet.`);
    else extra.push(`I've started ${lowerFirst(n.what)}; that one takes a few minutes, so I'll text you the result.`);
  }
  return extra.length ? `${text}\n\n${[...new Set(extra)].join("\n")}` : text;
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// ── Router ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Make one model turn safe to send back to the Anthropic API. The chains fall through LM Studio →
 * API → CLI per turn, so a turn produced by a non-Anthropic caller is replayed to the API on the
 * next one — and the API rejects (invalid_request_error 400) empty text blocks ("text content
 * blocks must be non-empty") and tool_use ids outside ^[a-zA-Z0-9_-]+$. Drops the former, rewrites
 * the latter; tool_result pairing follows automatically because results use the recorded id.
 */
export function sanitizeAssistantContent(content: ContentBlock[]): ContentBlock[] {
  return content
    .filter((c) => !(c.type === "text" && !(typeof c.text === "string" && c.text.trim())))
    .map((c, i) => {
      if (c.type !== "tool_use") return c;
      const id = String(c.id ?? "");
      return /^[a-zA-Z0-9_-]+$/.test(id) ? c : { ...c, id: `tu_${i}_${id.replace(/[^a-zA-Z0-9_-]/g, "") || "x"}` };
    });
}

/**
 * Route one request.
 *
 * Never throws. A failure returns `failed: true` with an honest message — a router that cannot run
 * must not degrade into free prose, because free prose is exactly what invented the original lie.
 */
export async function runIntentLoop<Ctx extends IntentContextBase, T extends IntentToolDef<Ctx>>(
  text: string,
  ctx: Ctx,
  adapter: IntentAdapter<Ctx, T>,
): Promise<IntentOutcome> {
  const calls: ToolCallRecord[] = [];
  const maxTurns = adapter.maxTurns ?? 6;

  if (adapter.preflight) {
    const stop = await adapter.preflight(text, ctx).catch(() => null);
    if (stop) return { reply: stop.reply, calls, failed: false, clarifying: true };
  }

  // Prior turns first, then the live turn — sanitized to what the API actually accepts, because
  // real transcripts are messier than the happy path: a rehydrated window can open on an assistant
  // turn (the API requires the first message to be `user`), and error rows/append-only stores
  // produce consecutive same-role turns (the API rejects those too). One malformed history row must
  // degrade to a slightly-lossy transcript, never to a failed turn — this exact case took CLARA
  // down with "my planning model just failed" on the first post-restart message.
  const messages: AnthropicMessage[] = [];
  for (const h of ctx.history ?? []) {
    if (!h.content || !h.content.trim()) continue; // empty content is rejected outright
    const last = messages[messages.length - 1];
    if (last && last.role === h.role && typeof last.content === "string") {
      last.content = `${last.content}\n${h.content}`; // merge consecutive same-role turns
    } else {
      messages.push({ role: h.role, content: h.content });
    }
  }
  while (messages.length && messages[0].role !== "user") messages.shift(); // must open on user
  const lastMsg = messages[messages.length - 1];
  let liveText = text;
  if (lastMsg && lastMsg.role === "user" && typeof lastMsg.content === "string") {
    liveText = `${lastMsg.content}\n${text}`;
    messages.pop();
  }
  // Same limits for every caller, not just the chat routes that sanitize their request body. The
  // images stay on this message for the whole loop, so every tool turn still sees them.
  const images = sanitizeImages(ctx.images);
  messages.push({
    role: "user",
    content: images.length
      ? [
          ...images.map((i): ContentBlock => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.dataBase64 } })),
          { type: "text", text: liveText.trim() ? liveText : "(no message — just the image)" },
        ]
      : liveText,
  });
  const byName = new Map(adapter.tools.map((t) => [t.name, t]));
  const system = `${await adapter.systemPrompt(ctx)}\n\n${REPLY_STYLE}${images.length ? `\n\n${IMAGE_GUIDANCE}` : ""}`;
  const wireTools = adapter.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

  let finalText = "";
  let outOfTurns = false;
  const notes: CallNote[] = [];

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const content = sanitizeAssistantContent(await adapter.callModel({ system, tools: wireTools, messages }));

      const textParts = content.filter((c) => c.type === "text" && typeof c.text === "string");
      // This turn's words only: a pre-tool "let me check" must not survive as the answer when the
      // closing turn comes back empty — that case gets the answer-now turn below instead.
      finalText = textParts.map((p) => p.text as string).join("\n").trim();

      const toolUses = content.filter((c) => c.type === "tool_use");
      if (!toolUses.length) break;
      if (turn === maxTurns - 1) outOfTurns = true;

      messages.push({ role: "assistant", content });
      const results: ToolResultBlock[] = [];

      for (const use of toolUses) {
        const useId = String(use.id ?? "");
        const def = byName.get(String(use.name ?? ""));
        const args = (use.input ?? {}) as Record<string, unknown>;
        if (!def) {
          results.push({ type: "tool_result", tool_use_id: useId, content: "no such tool", is_error: true });
          continue;
        }

        const gate = await adapter.gate(def, ctx);

        if (gate.decision === "block") {
          const line = `${def.name}: blocked by policy — ${gate.reason}`;
          calls.push({ name: def.name, args, resultLine: line, ok: false });
          notes.push({ kind: "blocked", what: describeSafe(def, args), detail: gate.reason });
          results.push({ type: "tool_result", tool_use_id: useId, content: line });
          continue;
        }

        // Two gates, and the stricter wins. `reversible: false` overrides an adapter that said
        // "run", because the agents' authority tables predate this router and do not distinguish
        // "writes to a local file" from "emails nine people that their meeting moved".
        // Exception: an adapter may vouch for an irreversible tool with `force: true` (origin-aware
        // autonomy, 2026-09) — logged so the audit trail shows who waived the row.
        const forced = gate.decision === "run" && gate.force === true;
        if (forced && !def.reversible) {
          await adapter.log(`gate.force: running irreversible tool ${def.name} without an approval row`, { gateForce: def.name }).catch(() => {});
        }
        if (gate.decision === "approve" || (!def.reversible && !forced)) {
          await adapter.queueApproval(def, args, ctx, text);
          // No approval codes in anything a person reads (owner-comms rule, 2026-09-24): the owner
          // is asked in plain words through CLARA's brief/call/email and answers in plain words.
          const line = `${def.name}: QUEUED for the owner's OK — they'll be asked in plain words and I'll do it once they say yes. Not done yet.`;
          calls.push({ name: def.name, args, resultLine: line, ok: false });
          notes.push({ kind: "queued", what: describeSafe(def, args) });
          results.push({ type: "tool_result", tool_use_id: useId, content: line });
          continue;
        }

        // Voice: a slow tool is started, not awaited. The caller gets told; the result arrives by
        // text. Checked AFTER the approval gate above, so a confirmation still wins over deferral —
        // "deploy that over the phone" queues, it does not silently start.
        if (ctx.deferSlow && def.speed === "slow") {
          (ctx.deferSlow as unknown as (t: T, a: Record<string, unknown>) => void)(def, args);
          const line = `${def.name}: started — that one takes a few minutes, so I'll text you the result.`;
          calls.push({ name: def.name, args, resultLine: line, ok: true });
          notes.push({ kind: "started", what: describeSafe(def, args) });
          results.push({ type: "tool_result", tool_use_id: useId, content: line });
          continue;
        }

        try {
          const out = await def.run(args, ctx);
          calls.push({ name: def.name, args, resultLine: out.line, ok: out.ok });
          results.push({ type: "tool_result", tool_use_id: useId, content: out.line, is_error: !out.ok });
          if (!out.ok) notes.push({ kind: "failed", what: describeSafe(def, args), detail: failureDetail(out.line, def.name) });
        } catch (e) {
          const line = `${def.name}: FAILED — ${String(e).slice(0, 200)}`;
          calls.push({ name: def.name, args, resultLine: line, ok: false });
          notes.push({ kind: "failed", what: describeSafe(def, args), detail: failureDetail(line, def.name) });
          results.push({ type: "tool_result", tool_use_id: useId, content: line, is_error: true });
        }
      }

      messages.push({ role: "user", content: results });
    }

    // Tools ran but the model never got to answer (turn budget spent mid-research, or a tool turn
    // with no words): one more turn, tools off, to say what it found. Never the raw results.
    if (calls.length && (outOfTurns || !finalText)) {
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown as ContentBlock[]).push({ type: "text", text: ANSWER_NOW });
      }
      const content = sanitizeAssistantContent(await adapter.callModel({ system, tools: wireTools, messages, toolChoice: "none" }));
      const words = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n").trim();
      if (words) finalText = words;
    }
  } catch (e) {
    await adapter.log(`intent router failed: ${String(e).slice(0, 200)}`, { failed: "router" }).catch(() => {});
    return {
      reply: "My planning model just failed on me, so I stopped rather than guess. Nothing was changed — try me again in a minute.",
      calls, failed: true, clarifying: false,
    };
  }

  // Defence C. If nothing ran and the model still talks like something did, replace it outright.
  if (!calls.length && claimsCompletion(finalText)) {
    await adapter.log(`BLOCKED a completion claim with no tool calls: "${finalText.slice(0, 160)}"`, { blocked: "false-completion" }).catch(() => {});
    return {
      reply: "I understood what you wanted but I didn't actually have a way to do it, and I nearly told you I had. I haven't touched anything — say it a different way, or tell me to add it.",
      calls, failed: false, clarifying: true,
    };
  }

  // Defence B. The model's words are the reply — raw tool output never is (it read as a robot dump,
  // 2026-10-09). But anything that did NOT simply succeed — failed, blocked, waiting on the owner,
  // started in the background — is stated in plain words unless the reply already says so, so the
  // model still can't paper over it.
  const reply = calls.length
    ? withNotes(finalText || "Here's where that landed.", notes)
    : (finalText || "I'm not sure what you'd like me to do with that.");

  // Only claim the turn when there is genuinely something to say: a question that needs an answer,
  // or a refusal. Ordinary conversation is better served by the caller's own path, which carries
  // memory-RAG and live status grounding this router deliberately does not.
  const asked = /\?\s*$/.test(finalText.trim());
  const refused = /\b(can'?t|cannot|don'?t have|not able|no way to)\b/i.test(finalText);

  return { reply, calls, failed: false, clarifying: !calls.length && (asked || refused) };
}

export * from "./images";
