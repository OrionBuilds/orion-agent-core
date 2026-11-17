// Native MCP client for Orion's mcp-server (localhost:3100/mcp, 470 tools). Used for
// deterministic, backend-driven CRM calls — as opposed to the CLI-tool-source wiring in each
// app's runner.ts/engines.ts, which is for ad hoc access during a dispatched Claude Code run.
//
// The MCP SDK's StreamableHTTPClientTransport snapshots `requestInit.headers` at CONSTRUCTION
// time, not per-request. A long-lived client reusing one transport would silently keep sending
// whatever JWT was current when it was built, including an expired one. So every call here opens
// a fresh connection with a freshly-minted token, calls once, and closes — no long-lived session.
// This costs a connection/session handshake per call; that's the correct tradeoff for a
// correctness-over-latency integration like this one.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OsAuth } from "../osauth/index.js";

export interface OsMcpConfig {
  auth: OsAuth;
  /** Defaults to the local Orion mcp-server. */
  url?: string;
  /** Client-side allow-list, defense-in-depth on top of server-side RLS. Exact tool names or
   *  "prefix_*" patterns — MCP `--allowedTools`-style prefix wildcards are NOT reliable inside
   *  the CLI, but a plain string-prefix check here is fine since we own the matching logic. */
  allow?: (toolName: string) => boolean;
  clientName?: string;
}

const DEFAULT_URL = "http://127.0.0.1:3100/mcp";

export class OsMcpClient {
  constructor(private readonly cfg: OsMcpConfig) {}

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const jwt = await this.cfg.auth.getFreshOsJwt();
    const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url ?? DEFAULT_URL), {
      requestInit: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const client = new Client({ name: this.cfg.clientName ?? "agent-core-osmcp", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async listTools(): Promise<string[]> {
    return this.withClient(async (client) => {
      const res = await client.listTools();
      return res.tools.map((t) => t.name);
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.cfg.allow && !this.cfg.allow(name)) {
      throw new Error(`osmcp: "${name}" is not in this agent's allow-list — refused client-side`);
    }
    return this.withClient(async (client) => {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) {
        const text = Array.isArray(res.content) ? res.content.map((c) => ("text" in c ? c.text : "")).join(" ") : "";
        throw new Error(`osmcp: tool "${name}" failed: ${text.slice(0, 300)}`);
      }
      return res.content;
    });
  }

  /**
   * G2 — principal-scoped tool access (the documented M0 guardrail).
   *
   * Agent DB users are partition-exempt at RLS (they serve every principal), so "only
   * touch this principal's records" must be enforced HERE, where the agent already
   * knows which principal a turn is for (G1 channel identity). Scoping applied:
   *   * contacts_list → owner_id filter injected (server supports it natively).
   *   * contacts_create → owner_id stamped, so new records land in the principal's
   *     partition and M0 RLS shows them to the right human.
   *   * other tools pass through unchanged — contact-rooted reads inherit scoping wherever
   *     the agent resolves contacts through a scoped contacts_list first. Broadening this
   *     per-tool is additive (add cases below) and never loosens anything.
   *
   * ⚠ RESIDUAL RISK (known, accepted for now): the "inherit scoping" story above is a CONVENTION,
   * not an enforcement. contacts_get / contacts_update / contact_agent_meta_* pass through with
   * whatever id the caller supplies, so a call site that obtains a contact id from anywhere other
   * than a scoped contacts_list (a stale cache, a cross-principal transcript, a model-invented id)
   * reaches another principal's record — the agent DB user is partition-exempt at RLS, so nothing
   * downstream catches it. Full remediation is an explicit per-tool policy map here with a
   * DEFAULT-DENY entry for every contact-rooted tool that carries an id (each entry either injects
   * the scope natively or verifies ownership via a scoped read before passing through), so a NEW
   * tool cannot silently join the unscoped set. Until that lands, every new callToolAs call site
   * must resolve contact ids through a scoped contacts_list first.
   */
  async callToolAs(
    principal: { key: string; osUserId: string } | null | undefined,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!principal?.osUserId) return this.callTool(name, args);
    const scoped: Record<string, unknown> = { ...args };
    if (name === "contacts_list") scoped["owner_id"] = principal.osUserId;
    if (name === "contacts_create" && scoped["owner_id"] === undefined) {
      scoped["owner_id"] = principal.osUserId;
    }
    return this.callTool(name, scoped);
  }
}

/** Prefix-list allow predicate — matches "foo_*" (any tool starting with "foo_") or an exact name. */
export function allowByPrefixes(prefixes: string[]): (toolName: string) => boolean {
  return (toolName) =>
    prefixes.some((p) => (p.endsWith("_*") ? toolName.startsWith(p.slice(0, -1)) : toolName === p));
}

export * from "./allowlists";
export * from "./contactsSync";
export * from "./projectsSync";
