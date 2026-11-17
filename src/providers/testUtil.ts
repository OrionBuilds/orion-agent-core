// Test-only helpers: a fetch stub that serves recorded fixtures and records what was requested.
// Not exported from the package index.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "__fixtures__");

export function fixture(provider: string, name: string): string {
  return readFileSync(join(FIXTURES, provider, name), "utf8");
}

export interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

/** A fetch that answers each call from `responses` in order; captures every request in `seen`. */
export function fakeFetch(responses: Array<{ status: number; body: string; contentType?: string }>, seen: Seen[] = []): typeof fetch {
  let i = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { h[k.toLowerCase()] = v; });
    seen.push({ url, method: init?.method ?? "GET", headers: h, body: typeof init?.body === "string" ? init.body : undefined });
    const r = responses[Math.min(i, responses.length - 1)]; i += 1;
    return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType ?? "application/json" } });
  };
  return impl as typeof fetch;
}

/** A fetch that never resolves until the abort signal fires — for timeout tests. */
export function hangingFetch(): typeof fetch {
  const impl = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  return impl as typeof fetch;
}
