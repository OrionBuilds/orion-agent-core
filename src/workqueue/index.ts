// Durable work queue — the overnight harness's spine (JARVIS-pivot Track B).
//
// Generalized from an earlier agent's worker (worker/index.ts), which earned these rules in production:
//   - single-instance mutex so two workers can never double-claim,
//   - claim is a CAS state flip with the claimer's pid recorded,
//   - a restarted worker SWEEPS: jobs claimed by a dead pid are either re-queued or, when their
//     workspace already holds deliverables, treated as partially done — NEVER blindly re-run,
//     because a job that may have completed must not fire twice,
//   - a hard attempt ceiling (default 2, mined from the reference tool's coding-lane) so a
//     poisoned job cannot burn the night retrying.
//
// Storage is one JSON file per job under <dataDir>/workqueue/jobs/, written tmp+rename so a crash
// mid-write never truncates. No sqlite, no daemon — the consumer (e.g. CLARA's scheduler worker)
// ticks claimNext()/complete() and this module owns only the durable state machine.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type JobState = "queued" | "claimed" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  agent: string;
  /** Discriminator for the consumer — "deepwork" first; dispatch/pool kinds join later. */
  kind: string;
  payload: Record<string, unknown>;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  /** Don't claim before this ISO time (lets "tonight" queue during the day). */
  notBefore?: string;
  /** Claimer's pid — liveness is checked against it during sweep. */
  claimedByPid?: number;
  /** Workspace dir for the current/last attempt — sweep looks in <workspace>/output for partials. */
  workspace?: string;
  createdAt: string;
  updatedAt: string;
  /** Final outcome text (summary, error, delivery note). */
  result?: string;
  /** True when the job finished with deliverables despite failing (partial delivery). */
  partial?: boolean;
}

export interface WorkQueueOptions {
  dataDir: string;
  /** Attempt ceiling for new jobs unless the job says otherwise. */
  defaultMaxAttempts?: number;
}

function nowISO(): string { return new Date().toISOString(); }

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but belongs to another user. Treating it as dead would let the
    // sweep re-queue a job that is still running and let the lock breaker steal a held lock.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class WorkQueue {
  private dir: string;
  private lockDir: string;
  private defaultMaxAttempts: number;

  constructor(opts: WorkQueueOptions) {
    this.dir = path.join(opts.dataDir, "workqueue", "jobs");
    this.lockDir = path.join(opts.dataDir, "workqueue", "worker.lock");
    this.defaultMaxAttempts = opts.defaultMaxAttempts ?? 2;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^a-z0-9_-]/gi, "")}.json`);
  }

  private async write(job: Job): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    job.updatedAt = nowISO();
    const f = this.file(job.id);
    await fs.writeFile(`${f}.tmp`, JSON.stringify(job, null, 2), "utf8");
    await fs.rename(`${f}.tmp`, f);
  }

  async get(id: string): Promise<Job | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), "utf8")) as Job;
    } catch {
      return null;
    }
  }

  async all(): Promise<Job[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const jobs: Job[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        jobs.push(JSON.parse(await fs.readFile(path.join(this.dir, n), "utf8")) as Job);
      } catch { /* one corrupt job must not hide the rest */ }
    }
    return jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async enqueue(input: { agent: string; kind: string; payload: Record<string, unknown>; notBefore?: string; maxAttempts?: number }): Promise<Job> {
    const job: Job = {
      id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      agent: input.agent,
      kind: input.kind,
      payload: input.payload,
      state: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts,
      notBefore: input.notBefore,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    await this.write(job);
    return job;
  }

  /**
   * Worker mutex — mkdir is atomic, so exactly one worker holds the lock. A dead holder's lock is
   * broken when its recorded pid no longer runs (the crash-recovery path). Bounded retries, not
   * recursion: an unexpected persistent mkdir failure must return false, never spin.
   */
  async acquireLock(): Promise<boolean> {
    await fs.mkdir(path.dirname(this.lockDir), { recursive: true }).catch(() => {});
    const pidFile = path.join(this.lockDir, "pid");
    for (let tries = 0; tries < 3; tries++) {
      try {
        // The pid file (created with wx) is the atomic artifact, NOT the directory: a loser that
        // raced the directory mkdir used to read a not-yet-written pid file, classify the lock as
        // malformed, break it, and acquire — putting two live workers behind one mutex.
        await fs.mkdir(this.lockDir, { recursive: true });
        await fs.writeFile(pidFile, String(process.pid), { encoding: "utf8", flag: "wx" });
        return true;
      } catch {
        const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
        if (pid === process.pid) return true; // re-entrant within our own process
        if (pid && pidAlive(pid)) return false;
        if (!pid) {
          // A holder may be between mkdir and pid write — breaking a fresh lock re-opens the
          // two-workers race, so give it a grace period before treating it as malformed.
          const age = await fs.stat(this.lockDir).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
          if (age < 5_000) return false;
        }
        // Stale (dead holder) or malformed lock — break it and retry.
        await fs.rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    return false;
  }

  async releaseLock(): Promise<void> {
    await fs.rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Claim the oldest eligible queued job. Callers are expected to hold the worker lock
   * (single-writer); the re-read after write is a belt-and-braces CAS so a process that skipped
   * acquireLock loses the race visibly instead of double-claiming — last rename wins, and the
   * loser sees the winner's pid on re-read.
   */
  async claimNext(now = new Date()): Promise<Job | null> {
    const jobs = await this.all();
    for (const job of jobs) {
      if (job.state !== "queued") continue;
      if (job.notBefore && new Date(job.notBefore) > now) continue;
      job.state = "claimed";
      job.claimedByPid = process.pid;
      job.attempts += 1;
      await this.write(job);
      const confirmed = await this.get(job.id);
      if (confirmed?.state === "claimed" && confirmed.claimedByPid === process.pid) return confirmed;
      // Another claimer's write landed after ours — the job is theirs, keep scanning.
    }
    return null;
  }

  /** Mark a claimed job as actively executing, recording its workspace for sweep/partials. */
  async markRunning(id: string, workspace: string): Promise<void> {
    const job = await this.get(id);
    if (!job) return;
    job.state = "running";
    job.workspace = workspace;
    await this.write(job);
  }

  async complete(id: string, outcome: { ok: boolean; result: string; partial?: boolean }): Promise<void> {
    const job = await this.get(id);
    if (!job) return;
    if (outcome.ok || outcome.partial) {
      job.state = "done";
      job.partial = outcome.partial;
      job.result = outcome.result;
    } else if (job.attempts >= job.maxAttempts) {
      job.state = "failed";
      job.result = outcome.result;
    } else {
      // Another attempt remains — back to the queue with the failure noted.
      job.state = "queued";
      job.result = outcome.result;
      job.claimedByPid = undefined;
    }
    await this.write(job);
  }

  async cancel(id: string): Promise<Job | null> {
    const job = await this.get(id);
    if (!job || job.state === "done" || job.state === "failed") return job;
    job.state = "cancelled";
    await this.write(job);
    return job;
  }

  /**
   * Boot sweep: any claimed/running job whose claimer pid is dead gets resolved — deliverables in
   * its workspace mean "partially done, deliver what exists"; nothing means re-queue (or fail at
   * the ceiling). Returns what changed so the worker can act (deliver partials, log).
   */
  async sweep(): Promise<{ requeued: Job[]; partials: Job[]; failed: Job[] }> {
    const requeued: Job[] = [];
    const partials: Job[] = [];
    const failed: Job[] = [];
    for (const job of await this.all()) {
      if (job.state !== "claimed" && job.state !== "running") continue;
      if (pidAlive(job.claimedByPid)) continue;

      const outDir = job.workspace ? path.join(job.workspace, "output") : null;
      const hasOutput = outDir
        ? await fs.readdir(outDir).then((f) => f.length > 0).catch(() => false)
        : false;

      if (hasOutput) {
        // May have completed — deliver what exists rather than run it again (never-run-twice rule).
        job.state = "done";
        job.partial = true;
        job.result = "worker died mid-run; deliverables found in workspace and treated as partial output";
        partials.push(job);
      } else if (job.attempts >= job.maxAttempts) {
        job.state = "failed";
        job.result = "worker died mid-run; attempt ceiling reached with nothing produced";
        failed.push(job);
      } else {
        job.state = "queued";
        job.claimedByPid = undefined;
        job.result = "worker died mid-run; re-queued";
        requeued.push(job);
      }
      await this.write(job);
    }
    return { requeued, partials, failed };
  }
}
