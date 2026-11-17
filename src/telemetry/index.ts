// Per-tool telemetry — call/success/latency/cost per tool call, one JSONL stream per agent
// (plan Phase 0 PR 0.8: "written from a single wrapper in agent-core so no tool can be added
// without instrumentation").
//
// Storage is a JSONL append stream (one line per call) rather than a Collection — telemetry is
// append-only, high-volume relative to everything else, and never updated in place. Reading is
// for the dashboard/aggregation layer, which scans and buckets.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface ToolTelemetryRecord {
  ts: string;
  agent: string;
  tool: string;
  ok: boolean;
  latencyMs: number;
  /** Model/token cost attributed to this call when the caller knows it; absent otherwise. */
  costUsd?: number;
  /** Short error string on failure — capped, never a full stack. */
  error?: string;
  /** Where the call came from (chat, sms, voice, scheduler, bus) when the caller knows. */
  source?: string;
  correlationId?: string;
}

export interface TelemetryOptions {
  dataDir: string;
  agent: string;
}

export class ToolTelemetry {
  private file: string;
  private agent: string;

  constructor(opts: TelemetryOptions) {
    this.agent = opts.agent;
    this.file = path.join(opts.dataDir, "tool-telemetry.jsonl");
  }

  /** Record one completed call. Never throws — telemetry must not break the tool path it measures. */
  async record(rec: Omit<ToolTelemetryRecord, "ts" | "agent">): Promise<void> {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        agent: this.agent,
        ...rec,
        error: rec.error?.slice(0, 300),
      } satisfies ToolTelemetryRecord);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, line + "\n", "utf8");
    } catch {
      /* deliberately swallowed */
    }
  }

  /**
   * Wrap a tool's run function so every invocation is recorded — success, failure, and latency —
   * with zero changes to the tool's own behaviour (the result/throw passes through untouched).
   * This is the "no tool can be added without instrumentation" choke point: wrap at catalog
   * registration, not per call site.
   */
  wrap<A extends unknown[], R>(
    toolName: string,
    run: (...args: A) => Promise<R>,
    meta?: { source?: string },
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      const t0 = Date.now();
      try {
        const out = await run(...args);
        // A tool that returns { ok: false } is a *tool-level* failure even though it didn't throw.
        const okField = (out as { ok?: unknown } | null)?.ok;
        await this.record({
          tool: toolName,
          ok: typeof okField === "boolean" ? okField : true,
          latencyMs: Date.now() - t0,
          source: meta?.source,
        });
        return out;
      } catch (e) {
        await this.record({
          tool: toolName,
          ok: false,
          latencyMs: Date.now() - t0,
          error: String(e),
          source: meta?.source,
        });
        throw e;
      }
    };
  }

  /** Aggregate the stream into per-tool stats for a window. Dashboard feed. */
  async stats(windowMs = 24 * 60 * 60_000): Promise<
    Record<string, { calls: number; failures: number; successRate: number; p50Ms: number; maxMs: number; costUsd: number }>
  > {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return {};
    }
    const cutoff = Date.now() - windowMs;
    const byTool = new Map<string, { latencies: number[]; failures: number; costUsd: number }>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec: ToolTelemetryRecord;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      // Date.parse(malformed) is NaN, and NaN < cutoff is false — an unparsable ts would slip
      // through the window filter forever instead of being dropped.
      const ts = Date.parse(rec.ts);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const e = byTool.get(rec.tool) ?? { latencies: [], failures: 0, costUsd: 0 };
      e.latencies.push(rec.latencyMs);
      if (!rec.ok) e.failures++;
      e.costUsd += rec.costUsd ?? 0;
      byTool.set(rec.tool, e);
    }
    const out: Record<string, { calls: number; failures: number; successRate: number; p50Ms: number; maxMs: number; costUsd: number }> = {};
    for (const [tool, e] of byTool) {
      const sorted = [...e.latencies].sort((a, b) => a - b);
      const calls = sorted.length;
      out[tool] = {
        calls,
        failures: e.failures,
        successRate: calls ? (calls - e.failures) / calls : 1,
        p50Ms: sorted[Math.floor(calls / 2)] ?? 0,
        maxMs: sorted[calls - 1] ?? 0,
        costUsd: e.costUsd,
      };
    }
    return out;
  }
}
