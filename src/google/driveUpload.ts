// Google Drive multipart upload builder — the request shape shared by FRIDAY and CLARA.
// Each app authenticates differently (own token store + gfetch), so this module builds the URL,
// headers and body and leaves the HTTP call to the caller. Owner rule 2026-09-24: every report an
// agent produces is a Google Drive file (Doc/Sheet/PDF) emailed with a summary and a link.
//
// `target: "doc"` asks Drive to CONVERT the upload into a native Google Doc. Feed it text/html
// (see markdownToBasicHtml) — Drive's HTML import keeps headings, lists and links, which the Docs
// API's plain insertText does not.

export type DriveTarget = "doc" | "sheet" | "pdf" | "file";

export interface DriveMultipartInput {
  name: string;
  parents?: string[];
  target: DriveTarget;
  sourceMime: string;
  bytes: Buffer;
  supportsAllDrives?: boolean;
}

export interface DriveMultipart { url: string; headers: Record<string, string>; body: Buffer }

export interface DriveFileRef { id: string; name: string; mimeType: string; webViewLink?: string }

const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const NATIVE: Partial<Record<DriveTarget, string>> = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
};

export function buildDriveMultipart(input: DriveMultipartInput): DriveMultipart {
  const boundary = `agentcore${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const metadata: Record<string, unknown> = { name: input.name };
  if (input.parents?.length) metadata.parents = input.parents;
  const native = NATIVE[input.target];
  if (native) metadata.mimeType = native;
  const sourceMime = input.target === "pdf" ? "application/pdf" : input.sourceMime;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: ${sourceMime}\r\nContent-Transfer-Encoding: base64\r\n\r\n`, "utf8"),
    Buffer.from(input.bytes.toString("base64"), "utf8"),
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);
  const all = input.supportsAllDrives ?? true;
  const url = `${UPLOAD}?uploadType=multipart&supportsAllDrives=${all ? "true" : "false"}&fields=id,name,mimeType,webViewLink`;
  return { url, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body };
}

export function parseDriveFile(json: unknown): DriveFileRef | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (typeof j.id !== "string" || !j.id) return null;
  return {
    id: j.id,
    name: typeof j.name === "string" ? j.name : "",
    mimeType: typeof j.mimeType === "string" ? j.mimeType : "",
    ...(typeof j.webViewLink === "string" ? { webViewLink: j.webViewLink } : {}),
  };
}

// ── Markdown → basic HTML (good enough for Drive's Doc import) ────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(md: string): string {
  const codes: string[] = [];
  const links: string[] = [];
  let s = md.replace(/`([^`]+)`/g, (_m, c: string) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  // Links are parked as placeholders so the emphasis passes below never touch URL characters
  // (`_` and `*` are common in paths and query strings).
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t: string, u: string) => {
    links.push(`<a href="${u.replace(/"/g, "%22")}">${t}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = s.replace(/(^|[^*])\*\*([^*]+)\*\*/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)]);
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
  return s;
}

/** Headings, paragraphs, bullet/numbered lists, bold/italic, links, inline + fenced code. Escaped. */
export function markdownToBasicHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let fence: string[] | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  for (const raw of lines) {
    if (fence) {
      if (/^```/.test(raw)) { out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`); fence = null; }
      else fence.push(raw);
      continue;
    }
    if (/^```/.test(raw)) { flushPara(); closeList(); fence = []; continue; }
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); closeList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul || ol) {
      flushPara();
      const kind: "ul" | "ol" = ul ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul ?? ol)![1].trim())}</li>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); closeList(); out.push("<hr>"); continue; }
    closeList();
    para.push(line.trim());
  }
  if (fence) out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
  flushPara(); closeList();
  return `<html><body>${out.join("\n")}</body></html>`;
}
