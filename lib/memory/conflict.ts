/**
 * Conflict resolution. Deterministic, ordered, and never delegated to the model.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT THAT MAKES THIS WORK
 *
 * Detecting that two facts *might* contradict is a language judgement, and the
 * model is good at it. Deciding *which one wins* is a policy judgement, and the
 * model is the wrong place for it: ask twice and you can get two answers, which
 * means the same inputs produce different memory on different days and no test
 * can pin it down.
 *
 * So extraction may nominate an existing item as contradicted. This module then
 * decides the outcome from provenance and time alone — no content, no model.
 *
 * The rules, in order:
 *   1. A fact the subject stated about themselves outranks one inferred about
 *      them. Someone saying "I moved to Berlin" beats the agent's guess.
 *   2. Within the same source type, newer outranks older.
 *   3. A genuine tie keeps the newer, supersedes the older, AND writes a
 *      `memory_conflict` event — so the resolution is visible rather than
 *      silent.
 */

export type MemorySource = 'stated' | 'inferred';

export interface Candidate {
  id?: string;
  sourceType: MemorySource;
  createdAt: Date;
}

export type Resolution =
  /** Keep both. They were not actually in conflict. */
  | { action: 'keep_both' }
  /** The incoming fact wins; mark the existing one superseded. */
  | { action: 'supersede'; supersededId: string; tie: boolean }
  /** The existing fact wins; the incoming one is dropped. */
  | { action: 'discard'; reason: string };

const RANK: Record<MemorySource, number> = { stated: 1, inferred: 0 };

/**
 * Resolve an incoming fact against an existing one it is said to contradict.
 *
 * Pure. Same inputs, same answer, forever — which is the entire point, and why
 * this is a function taking two dates and two enums rather than a prompt.
 */
export function resolve(incoming: Candidate, existing: Candidate): Resolution {
  if (!existing.id) return { action: 'keep_both' };

  // Rule 1 — provenance beats recency. A newer inference does not overturn
  // something the subject said about themselves.
  if (RANK[incoming.sourceType] > RANK[existing.sourceType]) {
    return { action: 'supersede', supersededId: existing.id, tie: false };
  }
  if (RANK[incoming.sourceType] < RANK[existing.sourceType]) {
    return {
      action: 'discard',
      reason: 'an inferred fact cannot overturn one the subject stated',
    };
  }

  // Rule 2 — same provenance, so recency decides.
  const delta = incoming.createdAt.getTime() - existing.createdAt.getTime();
  if (delta > 0) {
    // Rule 3 — two directly-stated facts in genuine conflict. The newer still
    // wins (people change their minds and say so), but this is flagged so a
    // human can see that something was overwritten rather than merged.
    const tie = incoming.sourceType === 'stated';
    return { action: 'supersede', supersededId: existing.id, tie };
  }

  if (delta < 0) {
    return { action: 'discard', reason: 'an older fact does not overturn a newer one' };
  }

  // Identical timestamps. Refusing to choose is the honest outcome: with no
  // ordering signal, picking one would be arbitrary dressed up as a rule.
  return {
    action: 'discard',
    reason: 'identical timestamps give no basis to prefer either; keeping the existing fact',
  };
}
