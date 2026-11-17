// Shared propose → approve → execute → notify scaffold — generalized from FRIDAY's client-system
// governance chain (its external-write proposals module), the most complete
// write-gating design in the fleet: every risky write becomes a pending Approval row first, a
// scheduler-driven executor scans for approved-but-unexecuted rows, executes through a typed
// payload dispatch, and stamps the outcome either way so a row never re-fires.
//
// What's generic (here): the state machine, the payload-in-detail encoding, the executor scan.
// What stays agent-specific (caller-supplied): the payload union, the actual side-effecting
// executors, the scheduler job registration, and notify wiring.
//
// A write path with bespoke safety shape (write-level ladder, wrong-account guard, mutex) this
// scaffold doesn't model should keep its own gate; use this for lower-stakes write tools.

import type { Collection } from "../store";

export type ProposalRisk = "low" | "medium" | "high" | "critical";

/**
 * The minimal structural shape the scaffold needs. Each agent's real Approval type (FRIDAY's
 * ~40-field one, CLARA's kind-keyed one once migrated) satisfies this via TypeScript structural
 * typing — no forced inheritance, no cross-agent type unification (deliberately: unifying the full
 * Approval type across agents is a much bigger, riskier migration than this scaffold needs).
 */
export interface BaseApproval {
  id: string;
  action: string;
  detail?: string;
  risk: ProposalRisk;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedAt?: string;
  executedAt?: string;
  resultNote?: string;
  dedupeRef?: string;
}

export interface ProposalScaffoldConfig<TPayload extends { kind: string }, TApproval extends BaseApproval> {
  /**
   * Unique payload marker within this agent's approvals store, e.g. "<<EXTW>>" (FRIDAY's
   * external-write one) or "<<CDRV>>" (a future CLARA drive-edit instance). Uniqueness is what lets
   * multiple scaffold instances coexist in one store.approvals without claiming each other's rows.
   */
  prefix: string;
  approvals: Collection<TApproval>;
  /** One executor per payload kind. Return ok+note; the scaffold stamps the row either way. */
  executors: Record<string, (payload: TPayload, approval: TApproval) => Promise<{ ok: boolean; note: string }>>;
  /** Human-readable one-liner per kind, shown in the approval's detail ahead of the encoded payload. */
  describe?: (payload: TPayload) => string;
  /** Build the full approval row from the scaffold's core fields — lets each agent stamp its own
   *  extra fields (authority tier, project id, notify-thread refs) without the scaffold knowing. */
  buildRow: (core: {
    id: string;
    action: string;
    detail: string;
    risk: ProposalRisk;
    status: "pending";
    requestedAt: string;
    dedupeRef?: string;
  }) => TApproval;
  newId?: () => string;
}

export interface ProposalScaffold<TPayload extends { kind: string }, TApproval extends BaseApproval> {
  propose(input: {
    action: string;
    payload: TPayload;
    risk?: ProposalRisk;
    dedupeRef?: string;
  }): Promise<TApproval>;
  /** Scan approved-but-unexecuted rows carrying this scaffold's prefix and execute them.
   *  Call from the agent's own scheduler job (e.g. an executor job every 30s).
   *  Returns a short human summary for the job log. */
  scanAndExecute(): Promise<string>;
  /** Decode a row's payload if it belongs to this scaffold, else null. Exposed for UIs. */
  decode(approval: TApproval): TPayload | null;
}

export function createProposalScaffold<TPayload extends { kind: string }, TApproval extends BaseApproval>(
  cfg: ProposalScaffoldConfig<TPayload, TApproval>,
): ProposalScaffold<TPayload, TApproval> {
  const { prefix } = cfg;
  if (!prefix || prefix.length < 3) throw new Error("proposal scaffold prefix must be a distinctive marker, e.g. <<EXTW>>");

  const encode = (payload: TPayload): string => `${prefix}${JSON.stringify(payload)}`;

  const decode = (approval: TApproval): TPayload | null => {
    const detail = approval.detail ?? "";
    // lastIndexOf, not indexOf: detail is "<summary>\n<prefix><json>", and a caller's describe()
    // may echo the prefix (or the payload) inside the summary — the FIRST occurrence would then
    // point at prose, JSON.parse would throw, and an approved action would be stamped FAILED.
    const at = detail.lastIndexOf(prefix);
    if (at === -1) return null;
    try {
      return JSON.parse(detail.slice(at + prefix.length)) as TPayload;
    } catch {
      return null;
    }
  };

  return {
    decode,

    async propose(input) {
      // Idempotency: an open or already-executed row with the same dedupeRef wins over a new one —
      // e.g. dedupe on "<system>:<taskId>".
      if (input.dedupeRef) {
        const existing = (await cfg.approvals.all()).find(
          (a) => a.dedupeRef === input.dedupeRef && (a.status === "pending" || (a.status === "approved" && !a.executedAt)),
        );
        if (existing) return existing;
      }
      const summary = cfg.describe ? cfg.describe(input.payload) : input.action;
      const row = cfg.buildRow({
        id: cfg.newId ? cfg.newId() : crypto.randomUUID(),
        action: input.action,
        detail: `${summary}\n${encode(input.payload)}`,
        risk: input.risk ?? "medium",
        status: "pending",
        requestedAt: new Date().toISOString(),
        dedupeRef: input.dedupeRef,
      });
      await cfg.approvals.insert(row);
      return row;
    },

    async scanAndExecute() {
      const rows = (await cfg.approvals.all()).filter(
        (a) => a.status === "approved" && !a.executedAt && (a.detail ?? "").includes(prefix),
      );
      if (!rows.length) return "nothing to execute";

      let ok = 0;
      let failed = 0;
      for (const row of rows) {
        // CAS-stamp executedAt FIRST (onlyIf still-unexecuted) so a crash mid-execute can't double-
        // fire on the next scan — an at-most-once bias. A stamped
        // row whose execution then fails carries the failure in resultNote for a human to re-drive.
        const claimed = await cfg.approvals.update(
          row.id,
          { executedAt: new Date().toISOString() } as Partial<TApproval>,
          { onlyIf: (r) => r.status === "approved" && !r.executedAt },
        );
        if (!claimed) continue; // another scan (or process) got it first

        const payload = decode(row);
        if (!payload) {
          await cfg.approvals.update(row.id, { resultNote: "FAILED: payload would not decode" } as Partial<TApproval>);
          failed++;
          continue;
        }
        const exec = cfg.executors[payload.kind];
        if (!exec) {
          await cfg.approvals.update(row.id, { resultNote: `FAILED: no executor for kind "${payload.kind}"` } as Partial<TApproval>);
          failed++;
          continue;
        }
        try {
          const res = await exec(payload, row);
          await cfg.approvals.update(row.id, { resultNote: res.ok ? res.note : `FAILED: ${res.note}` } as Partial<TApproval>);
          res.ok ? ok++ : failed++;
        } catch (e) {
          await cfg.approvals.update(row.id, { resultNote: `FAILED: ${String(e).slice(0, 300)}` } as Partial<TApproval>);
          failed++;
        }
      }
      return `executed ${ok}, failed ${failed}, of ${rows.length}`;
    },
  };
}
