// Cross-session recall — a per-agent SQLite log of every chat message, searchable months later.
//
// The design is ported from Hermes Agent's session store (MIT; hermes_state_schema.py /
// hermes_state_common.py), which earned three rules worth keeping:
//   - FTS5 is EXTERNAL-CONTENT over the canonical messages table (no second copy of every
//     message), kept in sync by insert/delete/update triggers rather than manual dual writes,
//   - FTS5 is OPTIONAL: probe for it at open, and when the runtime's SQLite lacks the module,
//     drop only the triggers so canonical writes keep working and search degrades to LIKE,
//   - WAL journaling with a graceful DELETE fallback (network drives and odd filesystems refuse
//     WAL; refusing to open over it would take recall down with it).
//
// What we deliberately did NOT port: Hermes's 40-column sessions table, trigram/CJK indexes,
// schema reconciler and migration chain. Our agents log short operator chat, not multi-model
// token accounting — sessions here are day buckets per channel, enough for "[date · title]"
// recall lines.
//
// Storage engine is node:sqlite (built-in since Node 22.5, stable on the installed Node 25) —
// zero native build steps on Windows, which is why better-sqlite3 lost the coin toss.
//
// Concurrency: one db file PER AGENT under that agent's own data dir. Never share a db file
// across agent processes — WAL tolerates it, but the day-bucket session upserts don't need to,
// and the whole point of per-agent stores is that recall never leaks across agents' memories.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'chat',
  title TEXT,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dedupe_hash TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_last ON sessions(agent, last_at DESC);
`;

// External-content FTS (the Hermes v23 shape): the index holds only the inverted index, reading
// row text back from messages via content_rowid. The delete/update triggers MUST replay the OLD
// content through the special 'delete' insert — external-content FTS has no stored copy to look
// up, so a plain DELETE would silently corrupt the index (Hermes's hard-won rule).
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

const FTS_TRIGGERS = ["messages_fts_insert", "messages_fts_delete", "messages_fts_update"];

export interface SessionStoreOptions {
  /** Force-disable FTS5 (tests exercise the LIKE fallback with this; normal opens auto-probe). */
  fts?: boolean;
}

export interface RecordInput {
  agent: string;
  /** Omit to day-bucket: one session per (agent, channel, calendar day) — see daySessionId(). */
  sessionId?: string;
  channel?: string;
  role: string;
  content: string;
  /** ISO timestamp; defaults to now. Part of the dedupe key, so backfill and live writes of the
   *  same underlying JSONL row must pass the same value (they do — both use the row's `ts`). */
  at?: string;
  /** Explicit session title; otherwise the first user message's head names the session. */
  title?: string;
}

export interface RecallMatch {
  sessionId: string;
  title: string | null;
  agent: string;
  channel: string;
  startedAt: string;
  lastAt: string;
  role: string;
  at: string;
  snippet: string;
}

export interface SessionRow {
  id: string;
  agent: string;
  channel: string;
  title: string | null;
  startedAt: string;
  lastAt: string;
  messageCount: number;
}

/** The one session-identity rule shared by live recording and JSONL backfill: a session is a
 *  calendar day on a channel. Both writers deriving the id the same way is what lets a backfill
 *  land in the sessions live recording already created (and vice versa) instead of forking. */
export function daySessionId(agent: string, channel: string, atISO: string): string {
  return `${agent}:${channel}:${atISO.slice(0, 10)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** First line, head-truncated — the session title fallback (Hermes's preview rule, simplified). */
function titleFrom(content: string): string {
  const line = content.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

// FTS5 treats bare punctuation as syntax (AND/OR/NEAR, quotes, columns filters); a user's raw
// question must never be able to raise a query-parse error. Quote every whitespace token so the
// whole query is plain terms with implicit AND — the Hermes sanitizer's approach, minus the
// operator passthrough we don't need.
function ftsQuery(raw: string): string {
  return raw
    .replace(/"/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => `"${t}"`)
    .join(" ");
}

function escapeLike(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class SessionStore {
  private db: DatabaseSync;
  /** True when the FTS5 virtual table exists and its triggers are live. */
  readonly ftsEnabled: boolean;
  /** "wal" normally; "delete" (or whatever SQLite settled on) where WAL was refused. */
  readonly journalMode: string;

  constructor(dbPath: string, opts: SessionStoreOptions = {}) {
    this.db = new DatabaseSync(dbPath);

    // WAL with graceful fallback: some filesystems refuse WAL, and SQLite reports the refusal by
    // answering with a different mode rather than throwing. Ask, read the answer, and only then
    // settle for rollback journaling — never fail the open over a journal mode.
    let mode = "";
    try {
      mode = String((this.db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode?: unknown })?.journal_mode ?? "");
    } catch { /* fall through to DELETE */ }
    if (mode.toLowerCase() !== "wal") {
      try {
        mode = String((this.db.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode?: unknown })?.journal_mode ?? "delete");
      } catch { mode = "unknown"; }
    }
    this.journalMode = mode.toLowerCase();
    this.db.exec("PRAGMA busy_timeout=3000");

    this.db.exec(SCHEMA_SQL);

    const wantFts = opts.fts !== false && this.probeFts5();
    if (wantFts) {
      this.db.exec(FTS_SQL);
      this.ftsEnabled = true;
      // Rows written while FTS was off (an { fts: false } open, or a runtime without FTS5) carry
      // no index entry, and external-content FTS5 keeps no stored copy — without a rebuild those
      // messages stay unsearchable forever while search() silently reports zero hits.
      try {
        const n = (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n?: number })?.n ?? 0;
        const f = (this.db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as { n?: number })?.n ?? 0;
        if (f !== n) this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      } catch { /* best effort — search still degrades gracefully */ }
    } else {
      // A db created under an FTS-capable runtime may carry triggers a non-FTS runtime cannot
      // fire without erroring the INSERT itself — drop them so canonical writes keep working.
      for (const t of FTS_TRIGGERS) {
        try { this.db.exec(`DROP TRIGGER IF EXISTS ${t}`); } catch { /* best effort */ }
      }
      this.ftsEnabled = false;
    }
  }

  private probeFts5(): boolean {
    try {
      this.db.exec("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(x)");
      this.db.exec("DROP TABLE temp._fts5_probe");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Record one message. Idempotent: the dedupe hash covers (session, role, timestamp, content),
   * so replaying a JSONL row that live recording already captured inserts nothing. Returns
   * whether a new row landed.
   */
  record(input: RecordInput): boolean {
    const at = input.at ?? new Date().toISOString();
    const channel = input.channel ?? "chat";
    const sessionId = input.sessionId ?? daySessionId(input.agent, channel, at);
    const content = input.content.trim();
    if (!content) return false;

    this.db.prepare(
      `INSERT INTO sessions (id, agent, channel, title, started_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_at = MAX(last_at, excluded.last_at),
         started_at = MIN(started_at, excluded.started_at)`,
    ).run(sessionId, input.agent, channel, input.title ?? null, at, at);

    // First user message names an untitled session — recall lines read "[date · what it was
    // about]" instead of "[date · (untitled)]". Never overwrites an explicit title.
    if (input.role === "user") {
      this.db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL").run(titleFrom(content), sessionId);
    }

    const res = this.db.prepare(
      "INSERT OR IGNORE INTO messages (session_id, role, content, created_at, dedupe_hash) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, input.role, content, at, sha256(`${sessionId}\n${input.role}\n${at}\n${content}`));
    return res.changes > 0;
  }

  /**
   * Full-text search across every recorded session, best match first (bm25 rank), each hit
   * carrying its session context so the caller can render "[date · title] snippet" directly.
   * Falls back to LIKE when FTS5 is unavailable — worse ranking, same shape.
   */
  search(input: { query: string; agent?: string; limit?: number }): RecallMatch[] {
    const limit = Math.max(1, Math.min(input.limit ?? 8, 50));
    const agentFilter = input.agent ?? null;

    if (this.ftsEnabled) {
      const match = ftsQuery(input.query);
      if (!match) return [];
      const rows = this.db.prepare(
        `SELECT m.session_id, s.title, s.agent, s.channel, s.started_at, s.last_at,
                m.role, m.created_at,
                snippet(messages_fts, 0, '', '', ' … ', 16) AS snip
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? AND (? IS NULL OR s.agent = ?)
         ORDER BY rank LIMIT ?`,
      ).all(match, agentFilter, agentFilter, limit) as Record<string, unknown>[];
      return rows.map((r) => this.toMatch(r, String(r.snip ?? "")));
    }

    // LIKE fallback: every token must appear (same implicit-AND contract), recency-ordered since
    // there is no rank. The snippet is a fixed window around the first token's first hit.
    const tokens = input.query.split(/\s+/).filter(Boolean).slice(0, 12);
    if (!tokens.length) return [];
    const clauses = tokens.map(() => "m.content LIKE ? ESCAPE '\\'").join(" AND ");
    const rows = this.db.prepare(
      `SELECT m.session_id, s.title, s.agent, s.channel, s.started_at, s.last_at,
              m.role, m.created_at, m.content
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE ${clauses} AND (? IS NULL OR s.agent = ?)
       ORDER BY m.created_at DESC LIMIT ?`,
    ).all(...tokens.map((t) => `%${escapeLike(t)}%`), agentFilter, agentFilter, limit) as Record<string, unknown>[];
    return rows.map((r) => {
      const content = String(r.content ?? "");
      const idx = content.toLowerCase().indexOf(tokens[0].toLowerCase());
      const from = Math.max(0, idx - 40);
      const snip = `${from > 0 ? "…" : ""}${content.slice(from, from + 120)}${from + 120 < content.length ? "…" : ""}`;
      return this.toMatch(r, snip);
    });
  }

  private toMatch(r: Record<string, unknown>, snippet: string): RecallMatch {
    return {
      sessionId: String(r.session_id),
      title: r.title == null ? null : String(r.title),
      agent: String(r.agent),
      channel: String(r.channel),
      startedAt: String(r.started_at),
      lastAt: String(r.last_at),
      role: String(r.role),
      at: String(r.created_at),
      snippet: snippet.replace(/\s+/g, " ").trim(),
    };
  }

  recentSessions(input: { agent?: string; limit?: number } = {}): SessionRow[] {
    const agentFilter = input.agent ?? null;
    const rows = this.db.prepare(
      `SELECT s.id, s.agent, s.channel, s.title, s.started_at, s.last_at,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n
       FROM sessions s
       WHERE (? IS NULL OR s.agent = ?)
       ORDER BY s.last_at DESC LIMIT ?`,
    ).all(agentFilter, agentFilter, Math.max(1, Math.min(input.limit ?? 10, 100))) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      agent: String(r.agent),
      channel: String(r.channel),
      title: r.title == null ? null : String(r.title),
      startedAt: String(r.started_at),
      lastAt: String(r.last_at),
      messageCount: Number(r.n ?? 0),
    }));
  }

  /**
   * Backfill an agent's existing JSONL chat logs (one row per line: `{ts, role, text, channel?}`
   * — the shape all agents' message stores write). Idempotent twice over: a per-file byte
   * offset in `meta` skips lines already read on earlier runs (so a boot-time call costs one
   * stat + tail-read, not a re-parse of months of history), and the message dedupe hash catches
   * anything that slips past the offset (a rewritten file, or rows live recording already saw).
   *
   * `dirOrFile` may be a single .jsonl file or a directory (every *.jsonl directly inside it).
   */
  async indexJsonl(
    dirOrFile: string,
    opts: { agent: string; channel?: string },
  ): Promise<{ files: number; ingested: number; skipped: number }> {
    let files: string[];
    const st = await fs.stat(dirOrFile).catch(() => null);
    if (!st) return { files: 0, ingested: 0, skipped: 0 };
    if (st.isDirectory()) {
      files = (await fs.readdir(dirOrFile)).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dirOrFile, n));
    } else {
      files = [dirOrFile];
    }

    let ingested = 0;
    let skipped = 0;
    for (const file of files) {
      const metaKey = `jsonl_offset:${path.resolve(file)}`;
      const prior = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey) as { value?: unknown } | undefined;
      let offset = Number(prior?.value ?? 0);
      const buf = await fs.readFile(file).catch(() => null);
      if (!buf) continue;
      if (offset > buf.length) offset = 0; // file was truncated/rewritten — hash dedupe covers the replay
      // Only complete lines: a writer mid-append can leave a partial last line, which must be
      // re-read next time, not half-parsed now.
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < offset) continue;
      const chunk = buf.subarray(offset, lastNl + 1).toString("utf8");

      this.db.exec("BEGIN");
      try {
        for (const line of chunk.split("\n")) {
          const s = line.trim();
          if (!s) continue;
          let row: Record<string, unknown>;
          try { row = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
          const text = typeof row.text === "string" ? row.text : typeof row.content === "string" ? row.content : "";
          const ts = typeof row.ts === "string" ? row.ts : "";
          const role = typeof row.role === "string" ? row.role : "";
          if (!text.trim() || !ts || !role) continue;
          const channel = typeof row.channel === "string" && row.channel ? row.channel : opts.channel ?? "chat";
          if (this.record({ agent: opts.agent, channel, role, content: text, at: ts })) ingested++;
          else skipped++;
        }
        this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(metaKey, String(lastNl + 1));
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    return { files: files.length, ingested, skipped };
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

export async function openSessionStore(dbPath: string, opts: SessionStoreOptions = {}): Promise<SessionStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  return new SessionStore(dbPath, opts);
}

/**
 * The model-facing summary of a search — Hermes renders hits as one compact line each so the
 * model can cite a past session without being handed the transcript. Ours: "[date · title]
 * (role) snippet". All agents' recall tools go through this, so the format cannot drift.
 */
export function formatRecallMatches(matches: RecallMatch[]): string {
  if (!matches.length) return "No past sessions match.";
  return matches
    .map((m) => `[${m.at.slice(0, 10)} · ${m.title ?? "(untitled)"}] (${m.role}) ${m.snippet}`)
    .join("\n");
}
