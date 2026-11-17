import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tryFallbackChain, idsFrom, classifyDispatchError, checkHop, newBusContext,
  IdenticalCallGuard, registerManifest, getManifest, listCapabilities,
  type DelegateEndpoint,
} from "./index";

const EP = (path: string, extract: DelegateEndpoint["extract"]): DelegateEndpoint => ({
  path,
  buildBody: (prompt) => ({ message: prompt }),
  extract,
});

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (url: string | URL | Request) => handler(String(url))) as typeof fetch;
}

test("first usable endpoint wins; later candidates never called", async () => {
  const calls: string[] = [];
  const out = await tryFallbackChain(
    "http://x",
    [
      EP("/a", (j) => ({ reply: (j as { reply: string }).reply })),
      EP("/b", () => ({ reply: "should never be reached" })),
    ],
    "hi",
    {
      fetchImpl: fakeFetch((url) => {
        calls.push(url);
        return Response.json({ reply: "from-a", tasks: [{ id: "t1" }] });
      }),
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.via, "/a");
  assert.equal(out.reply, "from-a");
  assert.deepEqual(calls, ["http://x/a"]);
});

test("falls through non-2xx and unusable bodies to the next candidate", async () => {
  const out = await tryFallbackChain(
    "http://x",
    [
      EP("/bad-status", (j) => ({ reply: String((j as { reply?: string }).reply ?? "") || undefined })),
      EP("/no-body", () => null),
      EP("/good", () => ({ reply: "finally" })),
    ],
    "hi",
    {
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith("/bad-status")) return new Response("nope", { status: 500 });
        if (url.endsWith("/no-body")) return Response.json({ unrelated: true });
        return Response.json({ reply: "finally" });
      }),
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.via, "/good");
});

test("all-candidates-timeout is indeterminate, not failed", async () => {
  const out = await tryFallbackChain(
    "http://x",
    [EP("/slow", () => ({ reply: "never" }))],
    "hi",
    {
      fetchImpl: (async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }) as typeof fetch,
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.indeterminate, true);
});

test("hard connection failure is NOT indeterminate", async () => {
  const out = await tryFallbackChain(
    "http://x",
    [EP("/dead", () => ({ reply: "never" }))],
    "hi",
    { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch },
  );
  assert.equal(out.ok, false);
  assert.equal(out.indeterminate, false);
});

test("idsFrom handles strings, id-objects, junk, and non-arrays", () => {
  assert.deepEqual(idsFrom(["a", { id: "b" }, { id: 3 }, null, 7]), ["a", "b"]);
  assert.deepEqual(idsFrom("not an array"), []);
  assert.deepEqual(idsFrom(undefined), []);
});

test("classifyDispatchError: timeout vs hard failure", () => {
  const t = new Error("x"); t.name = "AbortError";
  assert.equal(classifyDispatchError(t).indeterminate, true);
  assert.equal(classifyDispatchError(new Error("socket hang up")).indeterminate, false);
});

test("checkHop: allows within depth, denies at cap, detects cycles", () => {
  let ctx = newBusContext();
  const h1 = checkHop(ctx, "friday", "deploy.status");
  assert.ok(h1.allowed);
  ctx = h1.allowed ? h1.next : ctx;

  // Cycle: same agent+capability again anywhere in the chain
  const cyc = checkHop(ctx, "friday", "deploy.status");
  assert.equal(cyc.allowed, false);
  assert.equal(!cyc.allowed && cyc.denied, "cycle");

  // Depth: fill the chain to the default cap of 3
  const h2 = checkHop(ctx, "clara", "calendar.find_free_slot");
  ctx = h2.allowed ? h2.next : ctx;
  const h3 = checkHop(ctx, "friday", "campaign.status");
  ctx = h3.allowed ? h3.next : ctx;
  const over = checkHop(ctx, "clara", "contacts.lookup");
  assert.equal(over.allowed, false);
  assert.equal(!over.allowed && over.denied, "depth");
});

test("IdenticalCallGuard: trips on the 3rd identical call and on the run cap", () => {
  const g = new IdenticalCallGuard({ maxDepth: 3, maxToolCallsPerRun: 5, maxIdenticalCalls: 3 });
  assert.equal(g.check("t", { a: 1 }).ok, true);
  assert.equal(g.check("t", { a: 1 }).ok, true);
  const third = g.check("t", { a: 1 });
  assert.equal(third.ok, false);
  assert.match(third.reason ?? "", /stuck-loop/);

  const g2 = new IdenticalCallGuard({ maxDepth: 3, maxToolCallsPerRun: 2, maxIdenticalCalls: 3 });
  g2.check("a", 1); g2.check("b", 2);
  const over = g2.check("c", 3);
  assert.equal(over.ok, false);
  assert.match(over.reason ?? "", /tool-call cap/);
});

test("capability manifest registry round-trips", () => {
  registerManifest({
    agent: "clara",
    capabilities: {
      "calendar.find_free_slot": {
        description: "Find an open slot on the owner's calendar",
        toPrompt: (args) => `Find a free slot: ${JSON.stringify(args)}`,
      },
    },
  });
  assert.deepEqual(listCapabilities("clara"), ["calendar.find_free_slot"]);
  const m = getManifest("clara");
  assert.match(m!.capabilities["calendar.find_free_slot"]!.toPrompt({ duration: 30 }), /free slot/);
});
