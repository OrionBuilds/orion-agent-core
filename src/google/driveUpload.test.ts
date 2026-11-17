import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDriveMultipart, parseDriveFile, markdownToBasicHtml } from "./driveUpload";

test("doc target converts html to a native Google Doc with base64 body and parents", () => {
  const html = "<html><body><h1>Hi</h1></body></html>";
  const m = buildDriveMultipart({ name: "Report", parents: ["folder1"], target: "doc", sourceMime: "text/html", bytes: Buffer.from(html) });
  assert.match(m.url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink$/);
  const boundary = m.headers["Content-Type"].match(/boundary=(\S+)$/)?.[1];
  assert.ok(boundary);
  const body = m.body.toString("utf8");
  const parts = body.split(`--${boundary}`);
  assert.equal(parts.length, 4); // "", metadata, file, "--"
  const meta = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
  assert.deepEqual(meta, { name: "Report", parents: ["folder1"], mimeType: "application/vnd.google-apps.document" });
  assert.match(parts[2], /Content-Type: text\/html\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
  assert.equal(parts[2].split("\r\n\r\n")[1].trim(), Buffer.from(html).toString("base64"));
  assert.ok(body.endsWith(`--${boundary}--`));
});

test("sheet target uses the spreadsheet mime; pdf forces application/pdf; file keeps the source mime", () => {
  const sheet = buildDriveMultipart({ name: "s", target: "sheet", sourceMime: "text/csv", bytes: Buffer.from("a,b") });
  assert.match(sheet.body.toString(), /application\/vnd\.google-apps\.spreadsheet/);
  const pdf = buildDriveMultipart({ name: "p", target: "pdf", sourceMime: "application/octet-stream", bytes: Buffer.from("%PDF") });
  assert.match(pdf.body.toString(), /Content-Type: application\/pdf\r\n/);
  assert.doesNotMatch(pdf.body.toString(), /vnd\.google-apps/);
  const file = buildDriveMultipart({ name: "f", target: "file", sourceMime: "text/plain", bytes: Buffer.from("x"), supportsAllDrives: false });
  assert.match(file.url, /supportsAllDrives=false/);
  assert.match(file.body.toString(), /Content-Type: text\/plain\r\n/);
});

test("parseDriveFile accepts a Drive response and rejects junk", () => {
  assert.deepEqual(parseDriveFile({ id: "1", name: "n", mimeType: "m", webViewLink: "https://x" }), { id: "1", name: "n", mimeType: "m", webViewLink: "https://x" });
  assert.deepEqual(parseDriveFile({ id: "1" }), { id: "1", name: "", mimeType: "" });
  assert.equal(parseDriveFile({ name: "no id" }), null);
  assert.equal(parseDriveFile("nope"), null);
});

test("markdownToBasicHtml renders headings, lists, emphasis, links and code, escaped", () => {
  const html = markdownToBasicHtml("# Title\n\nSome **bold** and *it* with `a<b` and [link](https://e.com/x).\n\n- one\n- two\n\n1. first\n2. second\n\n```\nraw <code>\n```\n\n5 < 6 & 7 > 3");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>it<\/em>/);
  assert.match(html, /<code>a&lt;b<\/code>/);
  assert.match(html, /<a href="https:\/\/e\.com\/x">link<\/a>/);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
  assert.match(html, /<pre><code>raw &lt;code&gt;<\/code><\/pre>/);
  assert.match(html, /<p>5 &lt; 6 &amp; 7 &gt; 3<\/p>/);
});

test("markdownToBasicHtml never applies emphasis inside link URLs", () => {
  const html = markdownToBasicHtml("See [the report](https://example.com/_secret_/x?q=*foo*) and _this_.");
  assert.match(html, /<a href="https:\/\/example\.com\/_secret_\/x\?q=\*foo\*">the report<\/a>/);
  assert.match(html, /<em>this<\/em>/);
  assert.doesNotMatch(html, /href="[^"]*<em>/);
});
