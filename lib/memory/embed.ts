/**
 * Embedding provider — an interface with no implementation, on purpose.
 *
 * D-004 closed against wiring an embedding provider into v1. Anthropic ships no
 * embeddings API, so semantic ranking would mean a second vendor, a second key,
 * and a re-embedding migration path — for a candidate set the authorisation
 * filter has already reduced to tens of items.
 *
 * This file exists so that reversing that decision is a one-file change rather
 * than a refactor. It is not a placeholder for something forgotten; it is the
 * shape the upgrade would take, written down while the reasoning is fresh.
 *
 * ---------------------------------------------------------------------------
 * If this is ever implemented
 *
 * - **Voyage AI** is the pick. It is Anthropic's own documented recommendation
 *   and has a usable free tier.
 * - **HNSW, never ivfflat.** pgvector's `lists = rows/1000` degenerates to 1 at
 *   this scale, and Supabase's own docs name HNSW the default. Below roughly
 *   10k rows, a sequential scan beats both — so add the index when the row
 *   count justifies it, not when the column appears.
 * - **Carry `embedding_model` beside `embedding`.** A provider swap that leaves
 *   old vectors in place produces silently wrong neighbours; a column makes the
 *   mismatch detectable instead.
 * - **Nothing about the filter changes.** Authorisation is an anti-join plus an
 *   integer comparison and is correct under any ranker. That is precisely why
 *   this decision was deferrable rather than blocking.
 *
 * The honest weakness of shipping without it: lexical matching finds lexemes,
 * not meaning. In a legal product, "Delaware governing law" and "the client's
 * choice-of-law clause" are the same fact and share no words — which is exactly
 * the gap embeddings exist to close.
 */

export interface EmbeddingProvider {
  /** Vector for a single text. */
  embed(text: string): Promise<number[]>;
  /** Batched, because per-item HTTP for a re-embed of the whole table is absurd. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Stored alongside each vector so a provider change is detectable. */
  readonly model: string;
  readonly dimensions: number;
}

/**
 * There is deliberately no default export and no no-op implementation. A stub
 * returning zero vectors would let ranking silently degrade to "everything is
 * equally relevant" while looking like it worked — the retrieval path does not
 * import this module at all, and that absence is the safer failure.
 */
