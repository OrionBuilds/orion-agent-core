// Shared LM-Studio-backed embeddings utility — extracted from FRIDAY's embeddings.ts /
// CLARA's local fork of the same ~30 lines (see each app's git history for the pre-extraction
// duplication). Zero app-specific dependencies: callers resolve their own LM Studio base URL
// and embedding model name and pass them in.

export interface EmbedConfig {
  baseUrl: string;
  model: string;
}

export async function embed(texts: string[], cfg: EmbedConfig): Promise<number[][]> {
  const out: number[][] = [];
  // batch to keep requests reasonable
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 2000));
    const r = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      throw new Error(`LM Studio embeddings HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
    }
    // out is positional — callers pair out[i] with texts[i], so a short or reordered response
    // would silently shift every later pairing. The OpenAI-compatible response carries `index`
    // for exactly this reason: honour it, and refuse a count mismatch.
    const j = (await r.json()) as { data?: { index?: number; embedding: number[] }[] };
    const data = (j.data ?? []).slice().sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
    if (data.length !== batch.length) {
      throw new Error(`LM Studio embeddings: expected ${batch.length} vectors, got ${data.length}`);
    }
    for (const d of data) out.push(d.embedding);
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
