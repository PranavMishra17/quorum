import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * What the agent has recorded about the person asking.
 *
 * This lives in `lib/memory/` for the same reason every other memory read does:
 * CLAUDE.md's third non-negotiable puts all of them in one directory so there
 * is one place to audit. `pnpm check:boundaries` matches table queries rather
 * than RPC names, so it would not have caught this file elsewhere — the rule is
 * about where the knowledge lives, not only about what a regex can see.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT retrieve.ts
 *
 * `retrieve.ts` answers "what may the agent use IN THIS CHAT", and its whole
 * design is the surfacing rule: audience containment plus clearance floor,
 * evaluated in SQL before anything is ranked.
 *
 * This answers a different question — "what does it hold about ME" — and the
 * surfacing rule is the wrong filter for it. A fact learned about you in a room
 * you have since left is still a fact about you, and hiding it because it can
 * no longer surface anywhere would make this page a lie by omission. So the
 * filter here is `subject_user_id = auth.uid()` and nothing else, enforced in
 * `public.my_memory()` (migration 0019).
 *
 * These two must never be merged. One is an authorisation boundary, the other
 * is a subject-access request, and they disagree about which rows to return by
 * design.
 */

export interface MyMemoryItem {
  id: string;
  content: string;
  sourceType: 'stated' | 'inferred';
  status: 'candidate' | 'active' | 'superseded' | 'stale';
  confidence: number;
  clearanceLevel: number;
  originChatId: string;
  /** How many people were in the room when it was learned. Not who. */
  audienceSize: number;
  createdAt: string;
  expiresAt: string | null;
  supersededBy: string | null;
}

export async function myMemory<T>(client: SupabaseClient<T>): Promise<MyMemoryItem[]> {
  // `T` is generic here so this helper works from both the session-bound
  // server client and any future caller, but that genericity is exactly what
  // defeats the generated RPC return-type inference — TypeScript cannot narrow
  // `client.rpc('my_memory')`'s shape without knowing `T` is the real schema.
  // Untyped at this one boundary; the rows are validated by shape below instead.
  const untyped = client as unknown as SupabaseClient;
  const { data, error } = await untyped.rpc('my_memory');

  if (error) {
    // Surfaced, not swallowed. An empty page and a failed query look identical
    // to a reader, and "the agent knows nothing about you" is a much stronger
    // claim than "this did not load".
    console.error('[memory] my_memory failed', { code: error.code, message: error.message });
    throw new Error('could not load your memory');
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    content: String(r.content),
    sourceType: r.source_type as MyMemoryItem['sourceType'],
    status: r.status as MyMemoryItem['status'],
    confidence: Number(r.confidence ?? 0),
    clearanceLevel: Number(r.clearance_level ?? 0),
    originChatId: String(r.origin_chat_id),
    audienceSize: Number(r.audience_size ?? 0),
    createdAt: String(r.created_at),
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    supersededBy: r.superseded_by ? String(r.superseded_by) : null,
  }));
}

/**
 * Whether an item can currently surface anywhere at all.
 *
 * Only `active` is ever retrieved — a candidate is held precisely so the
 * decision is auditable rather than invisible, and a superseded or stale item
 * is history. Exported so the page can say "recorded, but never used" in those
 * words instead of showing a status enum and leaving the reader to guess.
 */
export function isRetrievable(item: MyMemoryItem): boolean {
  if (item.status !== 'active') return false;
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) return false;
  return true;
}

/** Plain-English reason an item is not in play. Null when it is. */
export function withheldReason(item: MyMemoryItem): string | null {
  if (item.status === 'candidate') {
    return 'Recorded but never used — either the agent was not confident enough, or it learned this in a turn that had read an untrusted document.';
  }
  if (item.status === 'superseded') {
    return 'Replaced by something newer. Kept so the history of what was believed, and when, stays readable.';
  }
  if (item.status === 'stale') {
    return 'Expired. It was marked as the kind of fact that goes out of date.';
  }
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) {
    return 'Past its expiry date.';
  }
  return null;
}
