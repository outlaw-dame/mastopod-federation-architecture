/**
 * Cosine similarity for L2-normalized embedding vectors.
 *
 * Because both vectors are already unit-length (all-MiniLM-L6-v2 normalizes
 * its output), cosine similarity reduces to a plain dot product — no sqrt
 * needed. Result is in [-1, 1]; for semantic similarity 0.75+ is a reliable
 * "very similar" threshold with MiniLM-L6.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

// ---------------------------------------------------------------------------
// Per-process pattern embedding cache
// ---------------------------------------------------------------------------

// Keyed by pattern text. Populated lazily on first evaluation, retained for
// the process lifetime. Embeddings are deterministic — no invalidation needed.
const cache = new Map<string, Float32Array>();

export function getCachedPatternEmbedding(pattern: string): Float32Array | undefined {
  return cache.get(pattern);
}

export function setCachedPatternEmbedding(pattern: string, embedding: Float32Array): void {
  cache.set(pattern, embedding);
}
