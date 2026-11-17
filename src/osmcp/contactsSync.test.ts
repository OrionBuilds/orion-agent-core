// Tests for the OS-contacts sync status mapping and the straggler push. OS contacts take only `active` or
// `archived` (contacts_status_check), so a local "past" client must go up as archived, and a push the OS
// refuses must not be retried on every refresh (2026-11-12: two past clients failed ~4,700 times).
//
// Run: npm test (inside agent-core)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ContactsSync, localStatusToOs, osStatusToLocal } from "./contactsSync";
import { Collection } from "../store";
import type { OsMcpClient } from "./index";

function mcp(v: unknown) {
  return [{ type: "text", text: JSON.stringify(v) }];
}

const OS_STATUSES = new Set(["active", "archived"]);

function fakeOs(opts: { refuseCreate?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let seq = 0;
  const client = {
    async callTool(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      switch (name) {
        case "contact_agent_meta_get": return mcp([]);
        case "contacts_create": {
          if (opts.refuseCreate) throw new Error("osmcp: tool \"contacts_create\" failed: down");
          if (args["status"] !== undefined && !OS_STATUSES.has(String(args["status"]))) {
            throw new Error(`osmcp: tool "contacts_create" failed: Input validation error: received "${String(args["status"])}"`);
          }
          return mcp({ id: `os-${++seq}` });
        }
        case "contact_agent_meta_set": return mcp({ ok: true });
        default: throw new Error(`unexpected tool ${name}`);
      }
    },
  } as unknown as OsMcpClient;
  return { client, calls };
}

async function tmpCollection(rows: Array<Record<string, unknown>>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-sync-"));
  const col = new Collection<{ id: string } & Record<string, unknown>>(dir, "clients");
  for (const r of rows) await col.insert(r as { id: string } & Record<string, unknown>);
  return { col, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("local statuses map only onto the two the OS accepts, and come back as the agent's own", () => {
  assert.equal(localStatusToOs("past"), "archived");
  assert.equal(localStatusToOs("active"), "active");
  assert.equal(localStatusToOs("prospect"), "active");
  assert.equal(localStatusToOs("paused"), "active");
  assert.equal(localStatusToOs(undefined), "active");
  assert.equal(osStatusToLocal("archived"), "past");
  assert.equal(osStatusToLocal("inactive"), "past", "rows written before the fix");
  assert.equal(osStatusToLocal("active"), "active");
});

test("a past client is pushed up as an archived contact, keeping 'past' in the agent's meta", async () => {
  const { client, calls } = fakeOs();
  const { col, cleanup } = await tmpCollection([{ id: "c-past", name: "Jordan Example", company: "Acme Co", status: "past" }]);
  try {
    const sync = new ContactsSync({ agent: "friday", client, enabled: () => true, collection: col });
    await sync.refresh(true);
    const create = calls.find((c) => c.name === "contacts_create");
    assert.equal(create?.args["status"], "archived");
    const meta = calls.find((c) => c.name === "contact_agent_meta_set");
    assert.equal((meta?.args["meta"] as Record<string, unknown>)["localStatus"], "past");
    assert.equal((await col.get("c-past"))?.["osContactId"], "os-1");
  } finally { await cleanup(); }
});

test("a push the OS refuses is not retried on every refresh, and is said once", async () => {
  const { client, calls } = fakeOs({ refuseCreate: true });
  const logs: string[] = [];
  const { col, cleanup } = await tmpCollection([{ id: "c1", name: "Example Widgets", status: "active" }]);
  try {
    const sync = new ContactsSync({ agent: "friday", client, enabled: () => true, collection: col, log: (e) => logs.push(e) });
    await sync.refresh(true);
    await sync.refresh(true);
    await sync.refresh(true);
    assert.equal(calls.filter((c) => c.name === "contacts_create").length, 1);
    assert.equal(logs.filter((e) => e === "contacts.sync.pushcreate.error").length, 1);
  } finally { await cleanup(); }
});
