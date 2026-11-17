// M2/M3 — OS-projects sync engine (used by FRIDAY).
//
// Each agent owns exactly ONE OS project pipeline (project_pipelines.owner_agent — e.g. Engineering
// for FRIDAY). This module mirrors the agent's LOCAL work units (FRIDAY: a
// project row) one-way into that pipeline as OS projects, so the Office
// and the Client Portal see a live stage, status, progress and risk for every engagement:
//
//   * identity: local id ↔ OS project via project_agent_meta.local_project_id (the meta row IS the
//     durable mapping — see the retry note in the create path).
//   * stage: the caller computes a stage NAME from local state (e.g. engineeringStage); this module resolves it to the owned pipeline's stage id and writes it via
//     projects_update. NEVER project_move_stage — the server writes the stage_changed activity the
//     portal shows from projects_update, and refuses stage ids outside the project's pipeline.
//   * status/stats: diffed against the live row, so a no-change refresh sends nothing.
//   * milestones: when the stage actually changes and the caller returns a milestone, one
//     project_activity_create (idempotent on source_ref) drops a card in the portal feed.
//   * tasks (optional, FRIDAY): coarse project_tasks mirror, ids remembered in a JSON sidecar.
//     DIFF-BASED since the 2026-10-28 audit (gap 1: an unconditional per-pass push re-opened 297
//     of the tasks the owner bulk-completed in the OS, every ~12 min). Each sidecar entry remembers
//     what FRIDAY last pushed (status + title). A field is written only when the LOCAL value moved
//     since that push AND differs from the live OS row (read first, once per project). An OS row
//     that is completed/cancelled is never moved back out of it. Legacy entries (a bare OS id with
//     no last-pushed state) adopt the current local values as the baseline and write nothing.
//
// Server-side scoping is real since M3 (owner_agent on the pipeline; projects_create/update refuse
// foreign pipelines), and this module ALSO refuses to write anywhere but its own pipeline: a
// pipeline whose owner_agent isn't this agent aborts the refresh, and a mapped project that no
// longer lists under the owned pipeline is skipped (never updated, never re-created).
//
// TTL-gated (5 min), single-flight, never throws — same lifecycle as ContactsSync.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { OsMcpClient } from "./index";

export type OsProjectStatus = "active" | "on_hold" | "completed" | "cancelled";
export type OsRiskLevel = "low" | "medium" | "high" | "critical";
export type OsPriority = "low" | "medium" | "high" | "urgent";

export interface LocalProjectStats {
  progress_percent?: number;
  risk_level?: OsRiskLevel;
  priority?: OsPriority;
  budget_amount?: number;
  /** YYYY-MM-DD (a full ISO timestamp is truncated to its date). */
  start_date?: string;
  /** YYYY-MM-DD (a full ISO timestamp is truncated to its date). */
  target_end_date?: string;
}

export interface LocalProject {
  /** The agent's local id (project_agent_meta.local_project_id). */
  id: string;
  name: string;
  description?: string;
  /** OS contact UUID, when the local client mirror already carries one. */
  contactId?: string;
  /** Fallback used ONLY on create when `contactId` is absent — e.g. push the client up first. */
  ensureContact?: () => Promise<string | null>;
  osStatus: OsProjectStatus;
  /** Stage NAME in the owned pipeline (case-insensitive match). */
  osStageName: string;
  stats: LocalProjectStats;
  /** Agent-private bookkeeping stored in project_agent_meta.meta on create. */
  meta?: Record<string, unknown>;
  /** Portal milestone card for a stage transition; return null for "no card". */
  milestone?: (from: string | null, to: string) => { title: string; detail: string } | null;
}

export interface LocalTaskRow {
  id: string;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "in_review" | "completed";
  priority?: "low" | "medium" | "high";
}

export interface ProjectsSyncConfig {
  agent: "friday";
  /** Name of the pipeline this agent owns (e.g. "Engineering"); matched case-insensitively. */
  pipelineName: string;
  client: OsMcpClient;
  enabled: () => boolean;
  localProjects: () => Promise<LocalProject[]>;
  /** Optional coarse task mirror (FRIDAY). Requires `taskMapPath`. */
  tasks?: (localProjectId: string) => Promise<LocalTaskRow[]>;
  /** JSON sidecar remembering local task id → OS project_tasks id, so re-syncs update, not duplicate. */
  taskMapPath?: string;
  /** Refresh no more often than this (default 5 min). */
  ttlMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

// ── OS row shapes (only the fields this module reads) ───────────────────────

export interface OsStageRow { id: string; name: string; sort_order?: number }
export interface OsPipelineRow {
  id: string;
  name: string;
  owner_agent?: "friday" | "clara" | null;
  sort_order?: number;
  stages?: OsStageRow[];
}
export interface OsProjectRow {
  id: string;
  name?: string;
  status?: string | null;
  pipeline_id?: string | null;
  stage_id?: string | null;
  progress_percent?: number | string | null;
  risk_level?: string | null;
  priority?: string | null;
  budget_amount?: number | string | null;
  start_date?: string | null;
  target_end_date?: string | null;
  contact_id?: string | null;
}
export interface OsTaskRow {
  id: string;
  project_id?: string;
  title?: string | null;
  status?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
}

/** One sidecar entry: the OS id plus what FRIDAY last pushed (absent on legacy entries). */
export interface TaskMapEntry {
  os: string;
  status?: string;
  title?: string;
  pushedAt?: string;
}
/** Accepted on read: legacy entries are a bare OS id string; the interim format used a TaskMapEntry object. Written: always the bare string (+ a `.state` sidecar). */
export type TaskMapFile = Record<string, string | TaskMapEntry>;

/** OS task statuses FRIDAY must never move a row out of (gap 1). */
const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled"]);

/**
 * Exported for tests: decide the patch for one mapped task. Pure.
 *  - `entry` = what FRIDAY last pushed (undefined fields ⇒ legacy entry ⇒ adopt local as baseline)
 *  - `row`   = the live OS row (read before writing)
 * Returns the patch to send (possibly empty) and whether a downgrade was refused.
 */
export function diffTask(
  local: LocalTaskRow,
  entry: TaskMapEntry,
  row: OsTaskRow,
): { patch: Record<string, unknown>; refusedDowngrade: boolean } {
  const patch: Record<string, unknown> = {};
  let refusedDowngrade = false;
  const liveStatus = row.status ?? null;
  const statusMoved = entry.status !== undefined && local.status !== entry.status;
  if (statusMoved && local.status !== liveStatus) {
    if (liveStatus && TERMINAL_TASK_STATUSES.has(liveStatus) && local.status !== "completed") {
      // Never re-open a completed/cancelled OS row (and never "complete" a cancelled one into a
      // different terminal state) — the OS side decided; FRIDAY's local revision stays local.
      refusedDowngrade = true;
    } else if (!(liveStatus === "cancelled" && local.status === "completed")) {
      patch.status = local.status;
    }
  }
  const titleMoved = entry.title !== undefined && local.title !== entry.title;
  if (titleMoved && local.title !== (row.title ?? null)) patch.title = local.title;
  return { patch, refusedDowngrade };
}

export function normaliseTaskMap(raw: TaskMapFile): Record<string, TaskMapEntry> {
  const out: Record<string, TaskMapEntry> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === "string" && v) out[k] = { os: v };
    else if (v && typeof v === "object" && typeof (v as TaskMapEntry).os === "string") out[k] = { ...(v as TaskMapEntry) };
  }
  return out;
}

export interface ProjectAgentMetaRow {
  project_id: string;
  agent: string;
  local_project_id: string | null;
  meta?: Record<string, unknown> | null;
  project?: { id: string; name?: string; status?: string; contact_id?: string | null } | null;
}

interface OwnedPipeline {
  id: string;
  name: string;
  stageIdByName: Map<string, string>; // lower-cased name → id
  stageNameById: Map<string, string>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function unwrapMcp(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

/** MCP list tools return either a bare array or `{ data|rows|items|<plural>: [] }` — take the first array. */
function asRows<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (Array.isArray(val)) return val as T[];
    }
  }
  return [];
}

function firstRow<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] as T) ?? null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["id"] === "string") return v as T;
    for (const val of Object.values(o)) {
      if (val && typeof val === "object" && typeof (val as { id?: unknown }).id === "string") return val as T;
    }
  }
  return null;
}

function normDate(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function normNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return String(v);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function omitUndefined<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** The fields the desired-state diff covers, normalised the same way for local and live values. */
function desiredOf(stageId: string, p: LocalProject): Record<string, string | number | undefined> {
  return {
    stage_id: stageId,
    status: p.osStatus,
    progress_percent: normNumber(p.stats.progress_percent),
    risk_level: normString(p.stats.risk_level),
    priority: normString(p.stats.priority),
    budget_amount: normNumber(p.stats.budget_amount),
    start_date: normDate(p.stats.start_date),
    target_end_date: normDate(p.stats.target_end_date),
  };
}

function liveOf(row: OsProjectRow): Record<string, string | number | undefined> {
  return {
    stage_id: normString(row.stage_id),
    status: normString(row.status),
    progress_percent: normNumber(row.progress_percent),
    risk_level: normString(row.risk_level),
    priority: normString(row.priority),
    budget_amount: normNumber(row.budget_amount),
    start_date: normDate(row.start_date),
    target_end_date: normDate(row.target_end_date),
  };
}

/** Exported for tests: `{field: value}` for every desired field that differs from live (undefined desired = skip). */
export function diffProject(stageId: string, local: LocalProject, live: OsProjectRow): Record<string, unknown> {
  const want = desiredOf(stageId, local);
  const have = liveOf(live);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined) continue;
    if (have[k] !== v) patch[k] = v;
  }
  return patch;
}

// projects_create's documented input carries these; progress/risk/priority go through
// projects_update right after (the server's create schema may reject unknown keys).
const CREATE_STAT_KEYS = new Set(["budget_amount", "start_date", "target_end_date"]);

// ── engine ──────────────────────────────────────────────────────────────────

export class ProjectsSync {
  private cfg: ProjectsSyncConfig;
  private lastRefreshAt = 0;
  private inflight: Promise<void> | null = null;
  private pipeline: OwnedPipeline | null = null;

  constructor(cfg: ProjectsSyncConfig) {
    this.cfg = cfg;
  }

  private log(event: string, data: Record<string, unknown>): void {
    try { this.cfg.log?.(event, data); } catch { /* logging must never break sync */ }
  }

  /** TTL-gated, single-flight, never throws. Call from schedulers or lazily before reads. */
  async refresh(force = false): Promise<void> {
    if (!this.cfg.enabled()) return;
    const ttl = this.cfg.ttlMs ?? 5 * 60_000;
    if (!force && Date.now() - this.lastRefreshAt < ttl) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh()
      .catch((e) => this.log("projects.sync.error", { error: String(e).slice(0, 200) }))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Resolved once per process (pipelines don't move); a miss/mismatch is NOT cached so a later
   *  OS deploy that adds the pipeline is picked up on the next TTL pass. */
  private async resolvePipeline(): Promise<OwnedPipeline | null> {
    if (this.pipeline) return this.pipeline;
    const rows = asRows<OsPipelineRow>(unwrapMcp(await this.cfg.client.callTool("project_pipelines_list", {})));
    const want = this.cfg.pipelineName.trim().toLowerCase();
    const hit = rows.find((r) => String(r.name ?? "").trim().toLowerCase() === want);
    if (!hit) {
      this.log("projects.sync.pipeline_unavailable", { pipeline: this.cfg.pipelineName, seen: rows.map((r) => r.name) });
      return null;
    }
    if (hit.owner_agent !== this.cfg.agent) {
      this.log("projects.sync.pipeline_owner_mismatch", {
        pipeline: hit.name, pipelineId: hit.id, owner: hit.owner_agent ?? null, agent: this.cfg.agent,
      });
      return null;
    }
    let stages = Array.isArray(hit.stages) ? hit.stages : [];
    if (stages.length === 0) {
      stages = asRows<OsStageRow>(unwrapMcp(await this.cfg.client.callTool("project_stages_list", { pipeline_id: hit.id })));
    }
    const stageIdByName = new Map<string, string>();
    const stageNameById = new Map<string, string>();
    for (const s of stages) {
      if (!s?.id || !s?.name) continue;
      stageIdByName.set(String(s.name).trim().toLowerCase(), s.id);
      stageNameById.set(s.id, String(s.name));
    }
    this.pipeline = { id: hit.id, name: hit.name, stageIdByName, stageNameById };
    return this.pipeline;
  }

  private async metaMap(): Promise<Map<string, string>> {
    const rows = asRows<ProjectAgentMetaRow>(
      unwrapMcp(await this.cfg.client.callTool("project_agent_meta_get", { agent: this.cfg.agent })),
    );
    const map = new Map<string, string>();
    for (const r of rows) if (r.local_project_id && r.project_id) map.set(r.local_project_id, r.project_id);
    return map;
  }

  private async liveRows(pipelineId: string): Promise<Map<string, OsProjectRow>> {
    const rows = asRows<OsProjectRow>(
      unwrapMcp(await this.cfg.client.callTool("projects_list", { pipeline_id: pipelineId, limit: 500 })),
    );
    const map = new Map<string, OsProjectRow>();
    for (const r of rows) if (r?.id) map.set(r.id, r);
    return map;
  }

  // The sidecar is the ONLY thing standing between a re-sync and duplicating every mirrored task
  // row, so a read failure must ABORT the sync (refresh logs it), never degrade to {} — an empty
  // map with 40 mirrored tasks means 40 fresh duplicates on the very next pass. Only a missing
  // file legitimately means "nothing mirrored yet".
  // On disk (2026-10-29, rollback-safe): `file` ALWAYS stays in the legacy shape
  // { [localTaskId]: osTaskId } so older code can still read it after a rollback, and the richer
  // "what FRIDAY last pushed" state lives in `${file}.state` ({ [localTaskId]: {status,title,pushedAt} }).
  // The reader accepts both: a `file` whose values are objects (written by the interim format) is
  // read as-is, and state entries are merged over the ids. Entries with no state behave as legacy
  // (the sync adopts local as the baseline), which is always safe.
  private async loadTaskMap(file: string): Promise<Record<string, TaskMapEntry>> {
    let map: Record<string, TaskMapEntry>;
    try {
      map = normaliseTaskMap(JSON.parse(await fs.readFile(file, "utf8")) as TaskMapFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`os-task-map read failed (${String(e).slice(0, 120)}) — aborting sync rather than duplicating every mirrored task`);
    }
    try {
      const state = JSON.parse(await fs.readFile(`${file}.state`, "utf8")) as Record<string, Partial<TaskMapEntry>>;
      for (const [k, v] of Object.entries(state ?? {})) {
        const e = map[k];
        if (!e || !v || typeof v !== "object") continue;
        if (typeof v.status === "string") e.status = v.status;
        if (typeof v.title === "string") e.title = v.title;
        if (typeof v.pushedAt === "string") e.pushedAt = v.pushedAt;
      }
    } catch { /* no/unreadable state file ⇒ legacy entries: safe, just re-baselines */ }
    return map;
  }
  private async saveTaskMap(file: string, map: Record<string, TaskMapEntry>): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    // A swallowed write left the NEXT sync with no ids — same duplication hazard as the read path.
    // Let it throw into refresh's error log so the failure is at least visible. Written via a temp
    // file + rename so a crash mid-write can't leave a truncated (→ unreadable → aborting) sidecar.
    // State first, ids second: if we die between the two, the ids file is the old one and the state
    // file is ahead only for ids that already exist — harmless.
    const legacy: Record<string, string> = {};
    const state: Record<string, Omit<TaskMapEntry, "os">> = {};
    for (const [k, e] of Object.entries(map)) {
      legacy[k] = e.os;
      if (e.status !== undefined || e.title !== undefined || e.pushedAt !== undefined) {
        state[k] = { ...(e.status !== undefined ? { status: e.status } : {}), ...(e.title !== undefined ? { title: e.title } : {}), ...(e.pushedAt !== undefined ? { pushedAt: e.pushedAt } : {}) };
      }
    }
    const tmpState = `${file}.state.tmp-${process.pid}`;
    await fs.writeFile(tmpState, JSON.stringify(state), "utf8");
    await fs.rename(tmpState, `${file}.state`);
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(legacy, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  /** Live OS task rows for one project, keyed by id. Null when the read failed (caller must not write blind). */
  private async liveTasks(osProjectId: string): Promise<Map<string, OsTaskRow> | null> {
    try {
      const rows = asRows<OsTaskRow>(
        unwrapMcp(await this.cfg.client.callTool("project_tasks_list", { project_id: osProjectId, limit: 2000 })),
      );
      const map = new Map<string, OsTaskRow>();
      for (const r of rows) if (r?.id) map.set(r.id, r);
      return map;
    } catch (e) {
      this.log("projects.sync.tasks_read_failed", { osProjectId, error: String(e).slice(0, 160) });
      return null;
    }
  }

  private async doRefresh(): Promise<void> {
    const pipeline = await this.resolvePipeline();
    if (!pipeline) { this.lastRefreshAt = Date.now(); return; }

    const [locals, map, live] = await Promise.all([
      this.cfg.localProjects(),
      this.metaMap(),
      this.liveRows(pipeline.id),
    ]);
    const mirrorTasks = Boolean(this.cfg.tasks && this.cfg.taskMapPath);
    const taskMap = mirrorTasks ? await this.loadTaskMap(this.cfg.taskMapPath!) : {};

    const counts = {
      projects: locals.length, created: 0, updated: 0, unchanged: 0, skipped: 0, milestones: 0,
      tasksCreated: 0, tasksUpdated: 0, tasksUnchanged: 0, tasksDowngradeRefused: 0, tasksSkipped: 0,
    };

    for (const p of locals) {
      const stageId = pipeline.stageIdByName.get(p.osStageName.trim().toLowerCase());
      if (!stageId) {
        this.log("projects.sync.unknown_stage", { localProjectId: p.id, stage: p.osStageName, pipeline: pipeline.name });
        counts.skipped++;
        continue;
      }

      let osId = map.get(p.id);

      if (!osId) {
        // ── create ──
        let contactId: string | null | undefined = p.contactId;
        if (!contactId && p.ensureContact) {
          try { contactId = await p.ensureContact(); } catch (e) {
            this.log("projects.sync.contact_failed", { localProjectId: p.id, error: String(e).slice(0, 160) });
          }
        }
        const createStats: Record<string, unknown> = {};
        const postStats: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p.stats ?? {})) {
          if (v === undefined) continue;
          if (CREATE_STAT_KEYS.has(k)) createStats[k] = k.endsWith("_date") ? normDate(v) : v;
          else postStats[k] = v;
        }
        const created = firstRow<{ id: string }>(unwrapMcp(await this.cfg.client.callTool("projects_create", omitUndefined({
          name: p.name,
          description: p.description,
          contact_id: contactId ?? undefined,
          pipeline_id: pipeline.id,
          stage_id: stageId,
          status: p.osStatus,
          ...createStats,
        }))));
        osId = created?.id;
        if (!osId) { counts.skipped++; continue; }

        // The meta row IS the durable local↔OS mapping (the in-process map dies with the process),
        // so projects_create succeeding while meta_set fails means the next sync can't see this
        // project and creates ANOTHER one. Retry the cheap write a few times; on total failure do
        // NOT cache the mapping (a process-local map over a missing durable row just hides the
        // problem until the next restart) and shout — this needs manual reconciliation.
        let metaOk = false;
        for (let attempt = 0; attempt < 3 && !metaOk; attempt++) {
          try {
            await this.cfg.client.callTool("project_agent_meta_set", {
              project_id: osId,
              agent: this.cfg.agent,
              local_project_id: p.id,
              meta: p.meta ?? {},
            });
            metaOk = true;
          } catch (e) {
            if (attempt === 2) {
              this.log("projects.sync.meta_failed", {
                localProjectId: p.id, osProjectId: osId, error: String(e).slice(0, 200),
                note: "OS project exists WITHOUT a local mapping — the next sync may create a duplicate; reconcile project_agent_meta manually",
              });
            } else {
              await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
          }
        }
        if (!metaOk) { counts.skipped++; continue; }
        map.set(p.id, osId);
        if (Object.keys(postStats).length > 0) {
          await this.cfg.client.callTool("projects_update", { id: osId, ...postStats }).catch((e: unknown) =>
            this.log("projects.sync.update_failed", { localProjectId: p.id, osProjectId: osId, error: String(e).slice(0, 160) }));
        }
        counts.created++;
        this.log("projects.sync.created", { localProjectId: p.id, osProjectId: osId, stage: p.osStageName, pipeline: pipeline.name });
      } else {
        // ── update ──
        const row = live.get(osId);
        if (!row) {
          // Mapped, but not listed under OUR pipeline: it lives in someone else's (or was deleted).
          // The server would refuse the write anyway; skip loudly and never re-create.
          this.log("projects.sync.cross_pipeline_refused", { localProjectId: p.id, osProjectId: osId, pipeline: pipeline.name });
          counts.skipped++;
          continue;
        }
        const patch = diffProject(stageId, p, row);
        // Backfill a missing OS contact on later passes too (e.g. the create-time contacts_create
        // failed): resolve or create it now and attach it with the same projects_update.
        if (row.contact_id === null) { // explicit null from the API; rows without the field are left alone
          let contactId: string | null | undefined = p.contactId;
          if (!contactId && p.ensureContact) {
            try { contactId = await p.ensureContact(); } catch (e) {
              this.log("projects.sync.contact_failed", { localProjectId: p.id, osProjectId: osId, error: String(e).slice(0, 160) });
            }
          }
          if (contactId) patch["contact_id"] = contactId;
        }
        if (Object.keys(patch).length === 0) {
          counts.unchanged++;
        } else {
          await this.cfg.client.callTool("projects_update", { id: osId, ...patch });
          counts.updated++;
          if (patch["stage_id"] !== undefined && p.milestone) {
            const from = row.stage_id ? (pipeline.stageNameById.get(row.stage_id) ?? null) : null;
            const to = pipeline.stageNameById.get(stageId) ?? p.osStageName;
            let card: { title: string; detail: string } | null = null;
            try { card = p.milestone(from, to); } catch { card = null; }
            if (card) {
              try {
                await this.cfg.client.callTool("project_activity_create", {
                  project_id: osId,
                  title: card.title,
                  detail: card.detail,
                  source_ref: `${this.cfg.agent}-stage:${osId}:${stageId}:${today()}`,
                });
                counts.milestones++;
              } catch (e) {
                this.log("projects.sync.milestone_failed", { osProjectId: osId, error: String(e).slice(0, 160) });
              }
            }
          }
        }
      }

      // ── task mirror (optional) ──
      if (mirrorTasks && osId) {
        let rows: LocalTaskRow[] = [];
        try { rows = await this.cfg.tasks!(p.id); } catch { rows = []; }
        // Read the OS side ONCE per project, and only when something mapped needs comparing.
        const needsLive = rows.some((t) => taskMap[t.id]);
        const live = needsLive ? await this.liveTasks(osId) : new Map<string, OsTaskRow>();
        const refused: string[] = [];
        for (const t of rows) {
          const entry = taskMap[t.id];
          try {
            if (entry) {
              if (!live) { counts.tasksSkipped++; continue; } // OS read failed — never write blind
              const row = live.get(entry.os);
              if (!row) { counts.tasksSkipped++; continue; } // deleted OS-side (or beyond the page) — leave it
              const { patch, refusedDowngrade } = diffTask(t, entry, row);
              if (refusedDowngrade) { counts.tasksDowngradeRefused++; if (refused.length < 10) refused.push(entry.os); }
              if (Object.keys(patch).length > 0) {
                await this.cfg.client.callTool("project_tasks_update", { id: entry.os, ...patch });
                counts.tasksUpdated++;
                entry.pushedAt = new Date().toISOString();
              } else {
                counts.tasksUnchanged++;
              }
              // Record the local values as "seen": a legacy entry adopts them as its baseline, a
              // refused downgrade isn't retried (and re-logged) every pass, and a real push is
              // remembered so the next pass sends nothing.
              entry.status = t.status;
              entry.title = t.title;
            } else {
              const created = firstRow<{ id: string }>(unwrapMcp(await this.cfg.client.callTool("project_tasks_create", omitUndefined({
                project_id: osId,
                title: t.title,
                description: t.description?.slice(0, 2000),
                status: t.status,
                priority: t.priority ?? "medium",
              }))));
              if (created?.id) {
                taskMap[t.id] = { os: created.id, status: t.status, title: t.title, pushedAt: new Date().toISOString() };
                counts.tasksCreated++;
              }
            }
          } catch (e) {
            // per-task best-effort; the entry keeps its old last-pushed state so the next pass retries
            this.log("projects.sync.task_write_failed", { localTaskId: t.id, error: String(e).slice(0, 160) });
          }
        }
        if (refused.length) {
          this.log("projects.sync.task_downgrade_refused", { osProjectId: osId, sample: refused });
        }
      }
    }

    if (mirrorTasks) await this.saveTaskMap(this.cfg.taskMapPath!, taskMap);
    this.lastRefreshAt = Date.now();
    this.log("projects.sync.ok", { pipeline: pipeline.name, ...counts });
  }
}
