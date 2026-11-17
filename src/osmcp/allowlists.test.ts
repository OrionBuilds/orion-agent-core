// The allowlists are the primary scoping boundary (see the header of allowlists.ts), so a name that
// drifts from what the OS server registers silently loses a capability, and a write that leaks
// into the Office's read-only list silently gains one. Both are checked here against a captured
// snapshot of the server's registered compliance tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPLIANCE_OS_TOOLS, OFFICE_OS_TOOLS, CLARA_OS_TOOLS, FRIDAY_OS_TOOLS, allowExact } from "./allowlists";

const registered = new Set(
  readFileSync(join(import.meta.dirname, "__fixtures__", "os-compliance-tools.txt"), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
);
const COMPLIANCE_PREFIX = /^(suppressions_|consents_|tracked_links_)/;

test("every compliance tool CLARA and the Office are granted is one the OS server registers", () => {
  for (const t of COMPLIANCE_OS_TOOLS) assert.ok(registered.has(t), `COMPLIANCE_OS_TOOLS names unregistered tool ${t}`);
  for (const t of OFFICE_OS_TOOLS) if (COMPLIANCE_PREFIX.test(t)) assert.ok(registered.has(t), `OFFICE_OS_TOOLS names unregistered tool ${t}`);
  assert.ok(registered.size >= 7);
});

test("the deliberate exclusions stay out of every list", () => {
  for (const banned of ["suppressions_remove", "opportunities_delete"]) {
    for (const [name, list] of [["COMPLIANCE", COMPLIANCE_OS_TOOLS], ["OFFICE", OFFICE_OS_TOOLS], ["CLARA", CLARA_OS_TOOLS]] as const) {
      assert.ok(!list.includes(banned), `${banned} must not be in ${name}_OS_TOOLS`);
    }
  }
});

test("OFFICE_OS_TOOLS is read-only: only get/list/search/timeline/check/stats shapes, and a subset of what CLARA can reach", () => {
  const readOnly = /(_get|_list|_search|_timeline|_check|_stats)$/;
  for (const t of OFFICE_OS_TOOLS) assert.match(t, readOnly, `${t} is not a read tool`);
  const clara = new Set(CLARA_OS_TOOLS);
  for (const t of OFFICE_OS_TOOLS) assert.ok(clara.has(t), `Office read ${t} is not something CLARA has`);
});

test("CLARA_OS_TOOLS contains the compliance tools and the folded deal tranche, without duplicates", () => {
  const clara = new Set(CLARA_OS_TOOLS);
  for (const t of COMPLIANCE_OS_TOOLS) assert.ok(clara.has(t));
  for (const t of ["pipelines_list", "opportunities_create", "opportunities_update"]) assert.ok(clara.has(t), t);
  assert.equal(clara.size, CLARA_OS_TOOLS.length, "duplicate tool names in CLARA_OS_TOOLS");
  assert.equal(new Set(FRIDAY_OS_TOOLS).size, FRIDAY_OS_TOOLS.length);
  // Compliance tools belong to CLARA only.
  for (const t of COMPLIANCE_OS_TOOLS) assert.ok(!FRIDAY_OS_TOOLS.includes(t), t);
  const allow = allowExact(OFFICE_OS_TOOLS);
  assert.equal(allow("suppressions_check"), true);
  assert.equal(allow("suppressions_add"), false);
});

test("FRIDAY may read and write project knowledge", () => {
  assert.ok(FRIDAY_OS_TOOLS.includes("project_knowledge_index"));
  assert.ok(FRIDAY_OS_TOOLS.includes("project_knowledge_get"));
  for (const t of ["project_knowledge_upsert", "project_knowledge_mark_stale", "project_knowledge_sync_state"]) assert.ok(FRIDAY_OS_TOOLS.includes(t), t);
});
