// Tests for the shared OS-projects sync engine — the properties the two bridges rely on: a new
// local project is created in the OWNED pipeline and mapped durably, a second pass with nothing
// changed sends nothing, a mapped project that left the pipeline is refused (never touched, never
// re-created), a pipeline owned by someone else aborts the whole refresh, an unknown stage name
// skips just that project, and a real stage change drops exactly one idempotent milestone card.
//
// Run: npm test (inside AGENTOS-CORE)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ProjectsSync, diffTask, normaliseTaskMap, type LocalProject, type OsProjectRow, type OsTaskRow } from "./projectsSync";
import type { OsMcpClient } from "./index";
import type { LocalTaskRow } from "./projectsSync";

type Call = { name: string; args: Record<string, unknown> };

const PIPELINE = {
  id: "pipe-eng",
  name: "Engineering",
  owner_agent: "friday",
  sort_order: 1,
  stages: [
    { id: "st-kick", name: "Kickoff", sort_order: 1 },
    { id: "st-prog", name: "In Progress", sort_order: 2 },
    { id: "st-crev", name: "Client Review", sort_order: 3 },
    { id: "st-done", name: "Completed", sort_order: 4 },
  ],
};

function mcp(v: unknown) {
  return [{ type: "text", text: JSON.stringify(v) }];
}

/** Fake OsMcpClient: records every call; behaviour comes from a tiny in-memory OS. */
function fakeOs(opts: {
  pipelines?: unknown[];
  metas?: Array<{ project_id: string; local_project_id: string | null }>;
  projects?: OsProjectRow[];
  failMetaSet?: boolean;
  tasks?: OsTaskRow[];
  failTasksList?: boolean;
} = {}) {
  const calls: Call[] = [];
  const pipelines = opts.pipelines ?? [PIPELINE];
  const metas = [...(opts.metas ?? [])];
  const projects = new Map((opts.projects ?? []).map((p) => [p.id, { ...p }]));
  const tasks = new Map((opts.tasks ?? []).map((t) => [t.id, { ...t }]));
  let seq = 0;
  const client = {
    async callTool(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      switch (name) {
        case "project_pipelines_list": return mcp(pipelines);
        case "project_stages_list": return mcp(PIPELINE.stages);
        case "project_agent_meta_get": return mcp(metas.map((m) => ({ ...m, agent: args["agent"], meta: {} })));
        case "projects_list": {
          const rows = [...projects.values()].filter((p) => p.pipeline_id === args["pipeline_id"]);
          return mcp(rows);
        }
        case "projects_create": {
          const id = `os-${++seq}`;
          const row: OsProjectRow = { id, ...(args as Partial<OsProjectRow>) };
          projects.set(id, row);
          return mcp(row);
        }
        case "projects_update": {
          const row = projects.get(String(args["id"]));
          if (!row) throw new Error("not found");
          Object.assign(row, args);
          return mcp(row);
        }
        case "project_agent_meta_set": {
          if (opts.failMetaSet) throw new Error("boom");
          metas.push({ project_id: String(args["project_id"]), local_project_id: String(args["local_project_id"]) });
          return mcp({ ok: true });
        }
        case "project_activity_create": return mcp({ id: `act-${++seq}` });
        case "project_tasks_create": {
          const row: OsTaskRow = { id: `task-${++seq}`, project_id: String(args["project_id"]), title: String(args["title"]), status: String(args["status"]) };
          tasks.set(row.id, row);
          return mcp(row);
        }
        case "project_tasks_update": {
          const row = tasks.get(String(args["id"]));
          if (row) Object.assign(row, args);
          return mcp(row ? [row] : []);
        }
        case "project_tasks_list": {
          if (opts.failTasksList) throw new Error("list down");
          return mcp([...tasks.values()].filter((t) => t.project_id === args["project_id"]));
        }
        default: throw new Error(`unexpected tool ${name}`);
      }
    },
  };
  return { client: client as unknown as OsMcpClient, calls, projects, metas, tasks, names: () => calls.map((c) => c.name) };
}

function local(over: Partial<LocalProject> = {}): LocalProject {
  return {
    id: "local-1",
    name: "Acme site",
    description: "Marketing site rebuild",
    contactId: "contact-1",
    osStatus: "active",
    osStageName: "In Progress",
    stats: { progress_percent: 40, risk_level: "low", budget_amount: 5000, start_date: "2026-09-01T00:00:00.000Z" },
    meta: { localStatus: "active" },
    ...over,
  };
}

function sync(os: ReturnType<typeof fakeOs>, projects: LocalProject[], extra: Partial<ConstructorParameters<typeof ProjectsSync>[0]> = {}) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const s = new ProjectsSync({
    agent: "friday",
    pipelineName: "engineering", // case-insensitive on purpose
    client: os.client,
    enabled: () => true,
    localProjects: async () => projects,
    log: (event, data) => events.push({ event, data }),
    ...extra,
  });
  return { s, events, has: (e: string) => events.some((x) => x.event === e) };
}

test("create path: new local project lands in the owned pipeline with the resolved stage and a durable meta row", async () => {
  const os = fakeOs();
  const { s, events } = sync(os, [local()]);
  await s.refresh(true);

  const create = os.calls.find((c) => c.name === "projects_create")!;
  assert.ok(create, "projects_create was called");
  assert.equal(create.args["pipeline_id"], "pipe-eng");
  assert.equal(create.args["stage_id"], "st-prog");
  assert.equal(create.args["status"], "active");
  assert.equal(create.args["contact_id"], "contact-1");
  assert.equal(create.args["budget_amount"], 5000);
  assert.equal(create.args["start_date"], "2026-09-01", "dates are sent as YYYY-MM-DD");
  assert.equal("progress_percent" in create.args, false, "non-create stats go through projects_update");

  const meta = os.calls.find((c) => c.name === "project_agent_meta_set")!;
  assert.deepEqual(meta.args, { project_id: "os-1", agent: "friday", local_project_id: "local-1", meta: { localStatus: "active" } });

  const post = os.calls.find((c) => c.name === "projects_update")!;
  assert.deepEqual(post.args, { id: "os-1", progress_percent: 40, risk_level: "low" });

  assert.ok(events.some((e) => e.event === "projects.sync.created"));
  assert.ok(!os.names().includes("project_move_stage"));
  const ok = events.find((e) => e.event === "projects.sync.ok")!;
  assert.equal(ok.data["created"], 1);
});

test("idempotent second run: nothing changed → no create, no update", async () => {
  const os = fakeOs();
  const { s } = sync(os, [local()]);
  await s.refresh(true);
  const before = os.calls.length;
  await s.refresh(true);
  const after = os.calls.slice(before).map((c) => c.name);
  assert.deepEqual(after.sort(), ["project_agent_meta_get", "projects_list"], `second pass only read: ${after.join(",")}`);
});

test("diff sends ONE projects_update with only the drifted fields (numbers numerically, dates by day)", async () => {
  const os = fakeOs({
    metas: [{ project_id: "os-9", local_project_id: "local-1" }],
    projects: [{
      id: "os-9", pipeline_id: "pipe-eng", stage_id: "st-prog", status: "active",
      progress_percent: "40", budget_amount: "5000.00", start_date: "2026-09-01", risk_level: "high",
    }],
  });
  const { s } = sync(os, [local({ stats: { progress_percent: 40, risk_level: "low", budget_amount: 5000, start_date: "2026-09-01T12:00:00Z" } })]);
  await s.refresh(true);
  const updates = os.calls.filter((c) => c.name === "projects_update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].args, { id: "os-9", risk_level: "low" });
});

test("cross-pipeline refusal: a mapped project not in the owned list is skipped, never updated or re-created", async () => {
  const os = fakeOs({
    metas: [{ project_id: "os-foreign", local_project_id: "local-1" }],
    projects: [{ id: "os-foreign", pipeline_id: "pipe-mkt", stage_id: "x", status: "active" }],
  });
  const { s, has } = sync(os, [local({ osStageName: "Completed", osStatus: "completed" })]);
  await s.refresh(true);
  assert.ok(has("projects.sync.cross_pipeline_refused"));
  assert.ok(!os.names().includes("projects_update"));
  assert.ok(!os.names().includes("projects_create"));
});

test("owner mismatch aborts before any read of local state or any write", async () => {
  const os = fakeOs({ pipelines: [{ ...PIPELINE, owner_agent: "clara" }] });
  let localRead = false;
  const { s, has } = sync(os, [local()], { localProjects: async () => { localRead = true; return [local()]; } });
  await s.refresh(true);
  assert.ok(has("projects.sync.pipeline_owner_mismatch"));
  assert.equal(localRead, false);
  assert.deepEqual(os.names(), ["project_pipelines_list"]);
});

test("missing pipeline logs pipeline_unavailable and writes nothing", async () => {
  const os = fakeOs({ pipelines: [{ ...PIPELINE, name: "Marketing", owner_agent: "clara" }] });
  const { s, has } = sync(os, [local()]);
  await s.refresh(true);
  assert.ok(has("projects.sync.pipeline_unavailable"));
  assert.deepEqual(os.names(), ["project_pipelines_list"]);
});

test("unknown stage name skips that project only", async () => {
  const os = fakeOs();
  const { s, has } = sync(os, [local({ id: "bad", osStageName: "Nope" }), local({ id: "good" })]);
  await s.refresh(true);
  assert.ok(has("projects.sync.unknown_stage"));
  const creates = os.calls.filter((c) => c.name === "projects_create");
  assert.equal(creates.length, 1);
  const meta = os.calls.find((c) => c.name === "project_agent_meta_set")!;
  assert.equal(meta.args["local_project_id"], "good");
});

test("stage change drops one milestone with the documented source_ref; a non-stage patch does not", async () => {
  const os = fakeOs({
    metas: [{ project_id: "os-5", local_project_id: "local-1" }],
    projects: [{ id: "os-5", pipeline_id: "pipe-eng", stage_id: "st-prog", status: "active", progress_percent: 40, risk_level: "low", budget_amount: 5000, start_date: "2026-09-01" }],
  });
  const seen: Array<[string | null, string]> = [];
  const { s } = sync(os, [local({
    osStageName: "Client Review",
    milestone: (from, to) => { seen.push([from, to]); return { title: `Moved to ${to}`, detail: "ready" }; },
  })]);
  await s.refresh(true);
  assert.deepEqual(seen, [["In Progress", "Client Review"]]);
  const act = os.calls.find((c) => c.name === "project_activity_create")!;
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(act.args["project_id"], "os-5");
  assert.equal(act.args["title"], "Moved to Client Review");
  assert.equal(act.args["source_ref"], `friday-stage:os-5:st-crev:${day}`);

  // Same project again, only progress moves → update, but no second card.
  const before = os.calls.length;
  const { s: s2 } = sync(os, [local({ osStageName: "Client Review", stats: { progress_percent: 60, risk_level: "low", budget_amount: 5000, start_date: "2026-09-01" }, milestone: () => ({ title: "x", detail: "y" }) })]);
  await s2.refresh(true);
  const tail = os.calls.slice(before).map((c) => c.name);
  assert.ok(tail.includes("projects_update"));
  assert.ok(!tail.includes("project_activity_create"));
});

test("meta write failure: project is not cached as mapped and is reported", async () => {
  const os = fakeOs({ failMetaSet: true });
  const { s, has } = sync(os, [local()]);
  await s.refresh(true);
  assert.ok(has("projects.sync.meta_failed"));
  assert.ok(!has("projects.sync.created"));
  assert.ok(!os.names().includes("projects_update"), "no post-create stats write without a mapping");
});

test("task mirror: creates once, then only pushes what changed locally; aborts on an unreadable sidecar", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "projsync-"));
  const mapFile = path.join(root, "os-task-map.json");
  const fake = fakeOs();
  let local1 = { id: "t1", title: "Build it", status: "in_progress" as LocalTaskRow["status"], priority: "high" as const };
  const tasks = async () => [local1];
  const { s } = sync(fake, [local()], { tasks, taskMapPath: mapFile });
  await s.refresh(true);
  assert.equal(fake.calls.filter((c) => c.name === "project_tasks_create").length, 1);
  // Rollback-safe format: the ids file is the legacy { local: osId }; what was pushed lives in .state.
  const ids = JSON.parse(await fs.readFile(mapFile, "utf8")) as Record<string, string>;
  const st = JSON.parse(await fs.readFile(`${mapFile}.state`, "utf8")) as Record<string, { status: string; title: string }>;
  assert.deepEqual(Object.keys(ids), ["t1"]);
  assert.match(ids["t1"], /^task-\d+$/);
  assert.equal(st["t1"].status, "in_progress");
  const saved = { t1: { os: ids["t1"] } };

  // Nothing changed → no create, no update.
  await s.refresh(true);
  assert.equal(fake.calls.filter((c) => c.name === "project_tasks_create").length, 1);
  assert.equal(fake.calls.filter((c) => c.name === "project_tasks_update").length, 0, "an unchanged task is never re-pushed");

  // Local status moves → exactly one update carrying ONLY the status (title unchanged is not rewritten).
  local1 = { ...local1, status: "in_review" };
  await s.refresh(true);
  const ups = fake.calls.filter((c) => c.name === "project_tasks_update");
  assert.equal(ups.length, 1);
  assert.deepEqual(ups[0].args, { id: saved["t1"].os, status: "in_review" });
  await s.refresh(true);
  assert.equal(fake.calls.filter((c) => c.name === "project_tasks_update").length, 1, "the same change is pushed once");

  // Unreadable sidecar (a directory) → the whole refresh aborts with projects.sync.error.
  const dir = path.join(root, "as-dir");
  await fs.mkdir(dir);
  const { s: s3, has } = sync(fake, [local()], { tasks, taskMapPath: dir });
  const before = fake.calls.length;
  await s3.refresh(true);
  assert.ok(has("projects.sync.error"));
  assert.ok(!fake.calls.slice(before).some((c) => c.name === "project_tasks_create"));
});

// Gap 1 regression (2026-10-28): the owner bulk-completed 1,732 OS tasks; 297 of them were mirrored from
// local tasks still at todo / in_review / in_progress, and the unconditional push re-opened all 297
// every ~12 minutes. With the diff-based mirror nothing is written — on the legacy sidecar (bare ids)
// AND on a sidecar that already records what was last pushed.
for (const legacy of [true, false]) {
  test(`297-task reopen scenario: OS bulk-complete is never undone (${legacy ? "legacy sidecar" : "last-pushed sidecar"})`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projsync-297-"));
    const mapFile = path.join(root, "os-task-map.json");
    const mix: LocalTaskRow["status"][] = [...Array(121).fill("todo"), ...Array(148).fill("in_review"), ...Array(28).fill("in_progress")];
    const localTasks: LocalTaskRow[] = mix.map((status, i) => ({ id: `lt-${i}`, title: `Task ${i}`, status }));
    const osTasks: OsTaskRow[] = localTasks.map((t, i) => ({
      id: `ot-${i}`, project_id: "os-9", title: t.title, status: "completed",
      updated_at: "2026-10-28T20:25:48Z", completed_at: "2026-10-28T20:25:48Z",
    }));
    const map: Record<string, unknown> = {};
    localTasks.forEach((t, i) => { map[t.id] = legacy ? `ot-${i}` : { os: `ot-${i}`, status: t.status, title: t.title }; });
    await fs.writeFile(mapFile, JSON.stringify(map));
    const fake = fakeOs({
      metas: [{ project_id: "os-9", local_project_id: "local-1" }],
      projects: [{ id: "os-9", pipeline_id: "pipe-eng", stage_id: "st-prog", status: "active", progress_percent: 40, risk_level: "low", budget_amount: 5000, start_date: "2026-09-01" }],
      tasks: osTasks,
    });
    const { s, events } = sync(fake, [local()], { tasks: async () => localTasks, taskMapPath: mapFile });
    for (let pass = 0; pass < 3; pass++) await s.refresh(true);
    assert.equal(fake.calls.filter((c) => c.name === "project_tasks_update").length, 0, "no OS task is written");
    assert.equal(fake.calls.filter((c) => c.name === "project_tasks_create").length, 0, "no duplicates");
    assert.equal(fake.calls.filter((c) => c.name === "project_tasks_list").length, 3, "one OS read per project per pass");
    assert.ok([...fake.tasks.values()].every((t) => t.status === "completed"), "all 297 stay completed");
    const ok = events.filter((e) => e.event === "projects.sync.ok").at(-1)!;
    assert.equal(ok.data["tasksUpdated"], 0);
    assert.equal(ok.data["tasksUnchanged"], 297);

    // Even a REAL local move (todo → in_progress) must not drag a completed OS row back out.
    localTasks[0] = { ...localTasks[0], status: "in_progress" };
    await s.refresh(true);
    assert.equal(fake.calls.filter((c) => c.name === "project_tasks_update").length, 0);
    assert.equal(fake.tasks.get("ot-0")!.status, "completed");
    assert.ok(events.some((e) => e.event === "projects.sync.task_downgrade_refused"));
  });
}

test("diffTask: completion flows up, downgrades of completed/cancelled rows are refused, titles only when moved", () => {
  const e = { os: "o1", status: "in_progress", title: "A" };
  assert.deepEqual(diffTask({ id: "l", title: "A", status: "completed" }, e, { id: "o1", status: "in_progress", title: "A" }).patch, { status: "completed" });
  const r = diffTask({ id: "l", title: "A", status: "todo" }, e, { id: "o1", status: "completed", title: "A" });
  assert.deepEqual(r.patch, {});
  assert.equal(r.refusedDowngrade, true);
  assert.deepEqual(diffTask({ id: "l", title: "A", status: "completed" }, e, { id: "o1", status: "cancelled", title: "A" }).patch, {}, "cancelled is never rewritten to completed");
  assert.deepEqual(diffTask({ id: "l", title: "A", status: "in_progress" }, e, { id: "o1", status: "todo", title: "A" }).patch, {}, "OS-side edit wins when the local value did not move");
  assert.deepEqual(diffTask({ id: "l", title: "B", status: "in_progress" }, e, { id: "o1", status: "in_progress", title: "A" }).patch, { title: "B" });
  assert.deepEqual(diffTask({ id: "l", title: "B", status: "todo" }, { os: "o1" }, { id: "o1", status: "in_progress", title: "A" }).patch, {}, "legacy entry adopts, never writes");
});

test("task mirror: a failed OS task read writes nothing for that project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "projsync-ro-"));
  const mapFile = path.join(root, "os-task-map.json");
  await fs.writeFile(mapFile, JSON.stringify({ t1: { os: "ot-1", status: "todo", title: "X" } }));
  const fake = fakeOs({
    metas: [{ project_id: "os-9", local_project_id: "local-1" }],
    projects: [{ id: "os-9", pipeline_id: "pipe-eng", stage_id: "st-prog", status: "active", progress_percent: 40, risk_level: "low", budget_amount: 5000, start_date: "2026-09-01" }],
    failTasksList: true,
  });
  const { s, has } = sync(fake, [local()], { tasks: async () => [{ id: "t1", title: "X", status: "completed" }], taskMapPath: mapFile });
  await s.refresh(true);
  assert.ok(has("projects.sync.tasks_read_failed"));
  assert.equal(fake.calls.filter((c) => c.name === "project_tasks_update").length, 0);
});

test("refresh never throws and is TTL-gated", async () => {
  const fake = fakeOs();
  const boom = { callTool: async () => { throw new Error("down"); } } as unknown as OsMcpClient;
  const { s, has } = sync(fake, [local()], { client: boom });
  await s.refresh(true);
  assert.ok(has("projects.sync.error"));

  const ok = fakeOs();
  const { s: s2 } = sync(ok, [local()], { ttlMs: 60_000 });
  await s2.refresh();
  const n = ok.calls.length;
  await s2.refresh();
  assert.equal(ok.calls.length, n, "second call inside the TTL is a no-op");
});

// ── rollback-safe sidecar (2026-10-29) ───────────────────────────────────────────────────────
test("os-task-map on-disk format: the ids file stays legacy ({local: osId}); state lives in .state; both formats read back", async () => {
    const mod = await import("./projectsSync");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-"));
    const file = path.join(dir, "os-task-map.json");
    const S = mod.ProjectsSync as unknown as { prototype: Record<string, (...a: unknown[]) => Promise<unknown>> };
    const save = S.prototype["saveTaskMap"]!;
    const load = S.prototype["loadTaskMap"]!;
    await save.call({}, file, { a: { os: "OS-A", status: "completed", title: "T", pushedAt: "2026-10-29T00:00:00Z" }, b: { os: "OS-B" } });
    const legacy = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(legacy, { a: "OS-A", b: "OS-B" }, "old code can read this file");
    const back = (await load.call({}, file)) as Record<string, { os: string; status?: string }>;
    assert.equal(back["a"]!.os, "OS-A");
    assert.equal(back["a"]!.status, "completed");
    assert.equal(back["b"]!.status, undefined);

    // Old code rewrote only the ids file (rollback then roll-forward): state is ignored for unknown ids, kept for known.
    await fs.writeFile(file, JSON.stringify({ a: "OS-A", c: "OS-C" }));
    const again = (await load.call({}, file)) as Record<string, { os: string; status?: string }>;
    assert.equal(again["a"]!.status, "completed");
    assert.equal(again["c"]!.os, "OS-C");
    assert.equal(again["c"]!.status, undefined);

    // Interim object-valued format in the main file still reads.
    await fs.writeFile(file, JSON.stringify({ z: { os: "OS-Z", status: "todo" } }));
    await fs.rm(`${file}.state`);
    const interim = (await load.call({}, file)) as Record<string, { os: string; status?: string }>;
    assert.deepEqual(interim["z"], { os: "OS-Z", status: "todo" });
    assert.deepEqual(normaliseTaskMap({ q: "x", r: { os: "y" } }), { q: { os: "x" }, r: { os: "y" } });
});
