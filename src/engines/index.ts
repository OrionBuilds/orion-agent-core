// Shared engine utilities — deliberately narrow. FRIDAY's/CLARA's actual completion
// dispatch and failover-chain logic diverge in ways that matter for live behavior (see each
// app's own engines.ts) and were NOT unified here — same reasoning as excluding authority/risk
// from this shared library. This module holds only the one genuinely pure, identical-across-apps
// piece: parsing a model's JSON reply out of markdown fences/leading prose.

/** Parse a model reply into JSON, tolerating ```json fences and leading prose. */
export function extractJSON<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // Grab the outermost {...} or [...] block.
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  // Braces inside JSON string values must not move the depth counter — {"pattern":"}"} would
  // otherwise close at the brace inside the string, truncate the slice, and return null for
  // valid JSON. Model replies embedding code, regex, or templates hit this constantly.
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
