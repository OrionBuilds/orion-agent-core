// GPU/host telemetry — collected from the WINDOWS side (plan PR 0.9b): amd-smi, rocprofiler and
// rocm-debugger do not work inside WSL2 on this hardware (plan §5.3), so the dashboard's GPU
// numbers must come from the host, not from inside the future inference-svc sidecar.
//
// Windows exposes GPU utilization and adapter memory through performance counters; typeperf ships
// with Windows, so this needs no driver tooling installed. Values are best-effort — a missing
// counter yields null for that field rather than an error, and callers render "unknown" not 0.

import { spawn } from "node:child_process";

export interface GpuSnapshot {
  at: string;
  /** 0-100 aggregate GPU engine utilization, or null if the counter was unavailable. */
  utilizationPct: number | null;
  /** Dedicated adapter memory in use (bytes), or null. */
  dedicatedBytes: number | null;
  /** Shared (system) adapter memory in use (bytes), or null. */
  sharedBytes: number | null;
}

function typeperf(counter: string, timeoutMs: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    const child = spawn("typeperf", ["-sc", "1", counter], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("close", () => {
      clearTimeout(timer);
      // typeperf CSV: header line, then one sample line: "timestamp","v1","v2",...
      const sample = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith('"'))[1];
      if (!sample) return resolve(null);
      const values = sample
        .split('","')
        .slice(1) // drop timestamp
        .map((v) => Number(v.replace(/"/g, "")))
        .filter((n) => Number.isFinite(n));
      resolve(values.length ? values : null);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** One best-effort snapshot. Each counter independently degrades to null. */
export async function gpuSnapshot(timeoutMs = 8000): Promise<GpuSnapshot> {
  const [util, dedicated, shared] = await Promise.all([
    typeperf("\\GPU Engine(*)\\Utilization Percentage", timeoutMs),
    typeperf("\\GPU Adapter Memory(*)\\Dedicated Usage", timeoutMs),
    typeperf("\\GPU Adapter Memory(*)\\Shared Usage", timeoutMs),
  ]);
  return {
    at: new Date().toISOString(),
    // GPU Engine exposes one instance per engine per process — the meaningful aggregate is the sum,
    // clamped to 100 (a busy multi-engine adapter can nominally exceed it).
    utilizationPct: util ? Math.min(100, util.reduce((a, b) => a + b, 0)) : null,
    dedicatedBytes: dedicated ? dedicated.reduce((a, b) => a + b, 0) : null,
    sharedBytes: shared ? shared.reduce((a, b) => a + b, 0) : null,
  };
}
