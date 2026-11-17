/**
 * ostasks — the shared agent-side runtime for Orion "Agent Tasks" scheduling.
 *
 * The OS is the source of truth for what runs and when. Each agent (CLARA/FRIDAY)
 * calls pollOsTasks() once per heartbeat; it pulls due work via the agent_tasks_poll MCP tool,
 * dispatches each run to a registered handler, and reports the outcome back. Client-visible
 * output is parked in the OS approval queue (via agent_run_report's request_approval) and
 * delivered on a later poll once a human approves.
 *
 * Shadow-first: when mode !== 'active', handlers still run but agent_run_report is called with
 * shadow:true, so no approval rows or client-visible side effects are created — the run is
 * recorded and the would-be approval is logged. This is the *_would_fire convention.
 *
 * The agents share no runtime surfaces except through agent-core; this module is that
 * shared surface.
 */

import type { OsMcpClient } from "../osmcp";

export type AgentTaskMode = "off" | "shadow" | "active";

export interface DueRun {
  run_id: string;
  schedule_id: string;
  task_key: string;
  subject_id: string | null;
  title: string;
  config: Record<string, unknown>;
  scheduled_for: string;
  mode: "shadow" | "active";
  risk_tier: "autonomous" | "owner_review" | "client_visible";
  output_kind: "owner_briefing" | "client_deliverable" | "housekeeping_report" | "none";
  approval_required: boolean;
  lease_expires_at: string;
  attempt: number;
}

export interface ResolvedRun {
  run_id: string;
  task_key: string;
  status: "approved" | "rejected";
  result: Record<string, unknown>;
  deliverable_file_id: string | null;
}

export interface ApprovalRequest {
  title: string;
  description?: string;
  draft_content: Record<string, unknown>;
  expires_hours?: number;
  approver_user_ids?: string[];
  action_type?: string;
}

export interface HandlerResult {
  summary?: string;
  result?: Record<string, unknown>;
  /** Present when the output is client-visible and must be human-approved before delivery. */
  requestApproval?: ApprovalRequest;
}

export interface PollContext {
  osClient: OsMcpClient;
  orgId: string;
  agentUserId: string;
  mode: AgentTaskMode;
  log?: (msg: string, extra?: unknown) => void;
}

/** Runs a due task. Return a summary + optional structured result + optional approval request. */
export type TaskHandler = (run: DueRun, ctx: PollContext) => Promise<HandlerResult>;
/** Delivers an approved run's output (send the email, post the portal page). Idempotency is
 *  handled by the OS (agent_run_deliver_confirm is a no-op if already delivered). */
export type DeliverHandler = (run: ResolvedRun, ctx: PollContext) => Promise<{ delivery?: Record<string, unknown> }>;

export interface HandlerRegistry {
  handlers: Record<string, TaskHandler>;
  deliver?: Record<string, DeliverHandler>;
  /** Runs when an approval is REJECTED (the deliver handler only runs on approve). Same
   *  signature as a deliver handler — it receives the rejected ResolvedRun and may perform a
   *  side effect (e.g. dispatch a follow-up to another agent). MUST be idempotent: if it throws,
   *  the run is not confirmed and re-presents on the next poll, so the handler runs again. */
  onReject?: Record<string, DeliverHandler>;
}

function unwrap(content: unknown): unknown {
  // MCP tool content is [{ type: 'text', text: '<json>' }]
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try {
        return JSON.parse((first as { text: string }).text);
      } catch {
        return (first as { text: string }).text;
      }
    }
  }
  return content;
}

export interface PollSummary {
  polled: boolean;
  claimed: number;
  completed: number;
  parked: number;
  failed: number;
  delivered: number;
  skipped: number;
}

/**
 * One poll cycle. Call from the agent's existing 60s scheduler tick.
 * `mode` is the agent-wide gate (env FRIDAY_OS_TASKS / CLARA_OS_TASKS).
 * Per-schedule mode is enforced OS-side; this gate lets an operator kill all OS-task
 * execution for one agent without touching the OS.
 */
export async function pollOsTasks(registry: HandlerRegistry, ctx: PollContext, limit = 5): Promise<PollSummary> {
  const log = ctx.log ?? (() => {});
  const s: PollSummary = { polled: false, claimed: 0, completed: 0, parked: 0, failed: 0, delivered: 0, skipped: 0 };
  if (ctx.mode === "off") return s;

  let payload: { due?: DueRun[]; resolved?: ResolvedRun[] };
  try {
    payload = unwrap(await ctx.osClient.callTool("agent_tasks_poll", { limit })) as typeof payload;
  } catch (e) {
    log(`ostasks: poll failed`, e);
    return s;
  }
  s.polled = true;
  const due = payload?.due ?? [];
  const resolved = payload?.resolved ?? [];
  s.claimed = due.length;

  // Best-effort lease renewal. Runs are claimed in a batch of up to `limit` but executed
  // sequentially, so a later run's lease can be mostly spent before its handler even starts —
  // and a long handler can outlive its own lease, letting the OS reassign the run to a second
  // poller mid-execution.
  const extendLease = async (runId: string): Promise<void> => {
    try {
      await ctx.osClient.callTool("agent_run_extend_lease", { run_id: runId, minutes: 10 });
    } catch (e) {
      log(`ostasks: lease extend failed for ${runId}`, e);
    }
  };

  // --- execute due runs ---
  let first = true;
  for (const run of due) {
    // Renew before every handler after the first (the first still holds a fresh claim).
    if (!first) await extendLease(run.run_id);
    first = false;
    const handler = registry.handlers[run.task_key];
    if (!handler) {
      log(`ostasks: no handler for ${run.task_key}, reporting failed`);
      await report(ctx, { run_id: run.run_id, org_id: ctx.orgId, status: "failed", error: `no handler registered for ${run.task_key}` });
      s.failed++;
      continue;
    }
    // Keep the lease alive while THIS handler runs — a slow build must not let the OS
    // expire and re-present the run to a concurrent poller.
    const keepAlive = setInterval(() => void extendLease(run.run_id), 60_000);
    try {
      let res: HandlerResult;
      try {
        res = await handler(run, ctx);
      } finally {
        clearInterval(keepAlive);
      }
      // The schedule's own approval_required flag was never consulted — the gate keyed only on
      // risk_tier === "client_visible". Several live schedules were approval_required=true at
      // risk_tier owner_review (e.g. friday.os_data_hygiene, clara.meeting_followups), so their runs went
      // straight to completed with no review gate at all. Harmless only while those handlers stay
      // read-only — os_data_hygiene's own description says "owner approves before apply".
      const requiresApproval = run.risk_tier === "client_visible" || run.approval_required === true;
      // A handler that returns requestApproval gets an approval, full stop. The
      // previous `&& requiresApproval` silently DROPPED a voluntary request on an
      // autonomous schedule and completed the run — so client-visible portal
      // replies drafted by ticket/CR triage were never parked, never delivered,
      // and looked done. The schedule's tier is a floor (the OS can force
      // review); it must never be a ceiling on the handler's own caution.
      const wantsApproval = !!res.requestApproval;
      const shadow = ctx.mode !== "active" || run.mode !== "active";
      if (wantsApproval) {
        if (shadow) log(`ostasks: ${run.task_key} would_fire approval (shadow)`, res.requestApproval);
        const reported = await report(ctx, {
          run_id: run.run_id,
          org_id: ctx.orgId,
          status: "completed",
          result_summary: res.summary,
          result: res.result,
          shadow,
          request_approval: res.requestApproval,
        });
        if (reported) {
          s.parked += shadow ? 0 : 1;
          s.completed += shadow ? 1 : 0;
        } else {
          // The handler's side effects happened but the OS never heard about them — the lease
          // will expire and the run WILL be re-presented, so counting it completed/parked here
          // would be a lie the poll summary tells while duplicate work is already scheduled.
          s.failed++;
        }
      } else {
        // A run the OS says needs review, whose handler produced nothing to review, is a broken
        // contract. Don't fail it — that would take out the four read-only schedules above today
        // — but refuse to let it pass as a clean completion. The alert surfaces in Agent Health.
        const gap = requiresApproval && !res.requestApproval;
        if (gap) log(`ostasks: ${run.task_key} requires approval but the handler returned none — completing with an alert`);
        const prior = (res.result as { alerts?: unknown[] } | undefined)?.alerts;
        const result = gap
          ? {
              ...(res.result ?? {}),
              alerts: [
                ...(Array.isArray(prior) ? prior : []),
                {
                  kind: "approval.contract_gap",
                  text: `${run.task_key} is marked approval_required (risk_tier ${run.risk_tier}) but its handler returned no approval request, so it completed without review.`,
                  priority: "warn",
                  dedupeKey: `approval.contract_gap:${run.task_key}`,
                },
              ],
            }
          : res.result;
        const reported = await report(ctx, {
          run_id: run.run_id,
          org_id: ctx.orgId,
          status: "completed",
          result_summary: res.summary,
          result,
        });
        // Same honesty rule as the parked branch: a lost report means the run re-presents.
        if (reported) s.completed++;
        else s.failed++;
      }
    } catch (e) {
      log(`ostasks: handler ${run.task_key} threw`, e);
      await report(ctx, { run_id: run.run_id, org_id: ctx.orgId, status: "failed", error: e instanceof Error ? e.message : String(e) });
      s.failed++;
    }
  }

  // --- deliver resolved approvals ---
  for (const r of resolved) {
    try {
      if (r.status === "approved" && registry.deliver?.[r.task_key]) {
        const out = await registry.deliver[r.task_key](r, ctx);
        await ctx.osClient.callTool("agent_run_deliver_confirm", { run_id: r.run_id, delivery: out.delivery ?? null });
        s.delivered++;
      } else if (r.status === "approved") {
        // Approved output with NO registered deliver handler is a deployment mismatch (an OS
        // schedule turned on before the agent build that registers the handler shipped), not a
        // rejection. Confirming here would permanently discard a human-approved client
        // deliverable — leave the run resolved so the next poll retries once the deploy
        // catches up, and shout so the mismatch is visible in the meantime.
        log(`ostasks: APPROVED run ${r.run_id} (${r.task_key}) has no deliver handler — NOT confirming; will retry next poll`);
        s.skipped++;
      } else if (registry.onReject?.[r.task_key]) {
        // rejected, and this task_key wants to react to rejection (e.g. hand off to another
        // agent). Run the reject handler, then confirm. If it throws, the outer catch logs and we
        // do NOT confirm — the run re-presents next poll and the handler runs again, so it MUST be
        // idempotent (same contract as deliver).
        const out = await registry.onReject[r.task_key](r, ctx);
        await ctx.osClient.callTool("agent_run_deliver_confirm", { run_id: r.run_id, delivery: out.delivery ?? { note: "rejected" } });
        s.skipped++;
      } else {
        // rejected with no delivery to perform: just clear it from `resolved`.
        await ctx.osClient.callTool("agent_run_deliver_confirm", { run_id: r.run_id, delivery: { note: r.status } });
        s.skipped++;
      }
    } catch (e) {
      log(`ostasks: deliver ${r.task_key} failed`, e);
    }
  }

  return s;
}

async function report(
  ctx: PollContext,
  args: {
    run_id: string;
    org_id: string;
    status: "completed" | "failed";
    result_summary?: string;
    result?: Record<string, unknown>;
    error?: string;
    shadow?: boolean;
    request_approval?: ApprovalRequest;
  },
): Promise<boolean> {
  // Never throw: report() runs inside the due-run loop AND inside its catch —
  // a transient MCP failure here used to abort the remaining due runs and the
  // entire resolved-delivery loop, and reject pollOsTasks itself. A missed
  // report is re-tried naturally (the run lease expires and re-presents) —
  // which is exactly why every registered handler MUST be idempotent: its side
  // effects have already happened by the time the report can fail, and the
  // re-presented run will execute it again. The boolean lets the caller count
  // the run failed instead of pretending the OS heard about it.
  try {
    await ctx.osClient.callTool("agent_run_report", args as unknown as Record<string, unknown>);
    return true;
  } catch (e) {
    ctx.log?.(`ostasks: agent_run_report failed for ${args.run_id} — run will re-present after lease expiry`, e);
    return false;
  }
}
