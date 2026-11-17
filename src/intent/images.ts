// Owner-attached images from a chat request body → ImageInput[] the loop can carry. Untrusted JSON,
// so everything is checked: only common image types whose bytes really are a complete image of that
// type (imageDimensions) no larger than MAX_IMAGE_SIDE on either side, base64
// only (a data: URL prefix is accepted and stripped), at most MAX_IMAGES, each at most
// MAX_IMAGE_BYTES decoded and all together at most MAX_TOTAL_BASE64 encoded. Anything else is
// dropped, never thrown — a bad attachment must not cost the owner their text turn.
//
// The caps sit inside the model providers' own: Anthropic rejects a base64 image over 10 MB encoded
// and a request over 32 MB, so 5 MB decoded per image (≈6.7 MB encoded) and 20 MB encoded in total
// leave room for the rest of the conversation. Client-side checks (Office attach/paste) and the chat
// routes use these same numbers, so nothing passes a client check and then fails at the provider.

import type { ImageInput } from "./index";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BASE64 = 20 * 1024 * 1024;
/** Anthropic rejects an image wider or taller than this. */
export const MAX_IMAGE_SIDE = 8000;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Strict standard base64: whole 4-char quanta, padding only at the end, and a lossless round
 *  trip — so "A" or "AAAA=" never reach a model API whose strict decoder would reject the request. */
function validBase64(data: string): boolean {
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  return Buffer.from(data, "base64").toString("base64") === data;
}

/** The file signature each declared type must start with — read from the first bytes only. */
function looksLike(mediaType: string, data: string): boolean {
  const head = Buffer.from(data.slice(0, 16), "base64");
  const at = (i: number, s: string) => head.subarray(i, i + s.length).toString("latin1") === s;
  switch (mediaType) {
    case "image/png": return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg": return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/gif": return at(0, "GIF87a") || at(0, "GIF89a");
    case "image/webp": return at(0, "RIFF") && at(8, "WEBP");
    default: return false;
  }
}

/**
 * Width and height read from the image's own header, or null when the bytes aren't a complete image
 * of that type. A cheap structural check, not a decoder: it catches signature-only stubs, truncated
 * uploads and wrong containers (a provider would reject those and cost the owner their turn), and it
 * gives the pixel size to check against MAX_IMAGE_SIDE. Pure; exported for tests.
 */
export function imageDimensions(b: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u32le = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + ((b[i + 3] << 24) >>> 0);
  const str = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  switch (mediaType) {
    case "image/png": {
      // Signature, then IHDR first (length 13); a complete file ends with the IEND chunk.
      if (b.length < 8 + 25 + 12 || u32be(8) !== 13 || str(12, 4) !== "IHDR") return null;
      if (str(b.length - 8, 4) !== "IEND") return null;
      return ok(u32be(16), u32be(20));
    }
    case "image/jpeg": {
      // Walk the segments from SOI to the first start-of-frame marker, which carries the size.
      if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
      let i = 2;
      while (i + 4 <= b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker === 0xff) { i++; continue; } // fill byte
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any frame
        const len = u16be(i + 2);
        if (len < 2 || i + 2 + len > b.length) return null;
        const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (sof) {
          // Complete files end with the end-of-image marker (some cameras append a short trailer).
          let eoi = false;
          for (let j = b.length - 2; j >= Math.max(i, b.length - 4096) && !eoi; j--) eoi = b[j] === 0xff && b[j + 1] === 0xd9;
          return len >= 7 && eoi ? ok(u16be(i + 7), u16be(i + 5)) : null;
        }
        i += 2 + len;
      }
      return null;
    }
    case "image/gif": {
      // Header + logical screen descriptor; a complete file ends with the 0x3B trailer.
      if (b.length < 14 || b[b.length - 1] !== 0x3b) return null;
      return ok(u16le(6), u16le(8));
    }
    case "image/webp": {
      // RIFF size must cover the payload, then one of the three VP8 chunk headers.
      if (b.length < 30 || str(0, 4) !== "RIFF" || str(8, 4) !== "WEBP" || u32le(4) + 8 > b.length) return null;
      const chunk = str(12, 4);
      if (chunk === "VP8 ") {
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null; // keyframe start code
        return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
      }
      if (chunk === "VP8L") {
        if (b[20] !== 0x2f) return null;
        const bits = u32le(21);
        return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8X") return ok(u24le(24) + 1, u24le(27) + 1);
      return null;
    }
    default:
      return null;
  }
}

function decodedBytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function sanitizeImages(raw: unknown): ImageInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageInput[] = [];
  let total = 0;
  for (const item of raw) {
    if (out.length >= MAX_IMAGES) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    let data = typeof o.dataBase64 === "string" ? o.dataBase64.trim() : "";
    let mediaType = typeof o.mediaType === "string" ? o.mediaType.trim().toLowerCase() : "";
    const m = data.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    if (m) { mediaType ||= m[1].toLowerCase(); data = m[2]; }
    if (mediaType === "image/jpg") mediaType = "image/jpeg";
    data = data.replace(/\s+/g, "");
    // Size first, from the string alone — an oversized payload is never decoded.
    if (!TYPES.has(mediaType) || !data || decodedBytes(data) > MAX_IMAGE_BYTES) continue;
    if (total + data.length > MAX_TOTAL_BASE64) continue;
    if (!looksLike(mediaType, data) || !validBase64(data)) continue;
    // A complete image of the declared type, within the provider's pixel limit (size checked
    // above, so this decode is bounded at MAX_IMAGE_BYTES).
    const dims = imageDimensions(Buffer.from(data, "base64"), mediaType);
    if (!dims || dims.width > MAX_IMAGE_SIDE || dims.height > MAX_IMAGE_SIDE) continue;
    total += data.length;
    out.push({ mediaType, dataBase64: data });
  }
  return out;
}
