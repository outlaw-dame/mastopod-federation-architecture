/**
 * EmbeddingModel
 *
 * Singleton wrapper around the all-MiniLM-L6-v2 ONNX pipeline (via
 * @xenova/transformers). Embeddings are 384-dimensional, mean-pooled, and
 * L2-normalized — making cosine similarity equivalent to a dot product.
 *
 * The pipeline is loaded lazily on first call to embed() and shared across
 * all subsequent invocations. If the model cannot be loaded (network, disk,
 * or permission failure), tryEmbed() returns null and keyword evaluation
 * degrades gracefully to literal-only matching (fail-open).
 *
 * Environment variables:
 *   HF_CACHE_DIR  — override the local model cache directory
 *                   (default: node_modules/.cache/huggingface)
 */

import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

// Respect a custom cache directory so Docker images can pre-bake the model.
if (process.env["HF_CACHE_DIR"]) {
  env.cacheDir = process.env["HF_CACHE_DIR"];
}

// ---------------------------------------------------------------------------
// Singleton pipeline
// ---------------------------------------------------------------------------

let loadPromise: Promise<FeatureExtractionPipeline> | null = null;

function getOrLoad(): Promise<FeatureExtractionPipeline> {
  if (!loadPromise) {
    loadPromise = (
      pipeline("feature-extraction", MODEL_ID, { quantized: true }) as Promise<FeatureExtractionPipeline>
    ).catch((err: unknown) => {
      // Allow a retry on the next call — don't cache the failure permanently.
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pre-warm the model pipeline in the background. Call this during sidecar
 * startup if semantic keyword rules are active, so the first inbound message
 * does not pay the ~2–5 s model load cost.
 */
export function prewarmEmbeddingModel(): void {
  void getOrLoad().catch(() => {
    // Suppress — failure is already surfaced when embed() is called.
  });
}

/**
 * Embed `text` with all-MiniLM-L6-v2 (mean pool, L2-normalize).
 * Returns a Float32Array of length 384.
 * Throws on model load failure or pipeline error.
 *
 * Input is truncated at 512 chars — well within the model's 256-token
 * context window for typical Latin-script content.
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getOrLoad();
  const truncated = text.length > 512 ? text.slice(0, 512) : text;
  // The pipeline returns a Tensor; .data is the underlying TypedArray.
  const output = await pipe(truncated, { pooling: "mean", normalize: true });
  return output.data as Float32Array;
}

/**
 * Fail-open wrapper around embed(). Returns null instead of throwing when the
 * model is unavailable, allowing callers to skip semantic checks gracefully.
 */
export async function tryEmbed(text: string): Promise<Float32Array | null> {
  try {
    return await embed(text);
  } catch {
    return null;
  }
}
