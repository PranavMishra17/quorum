import type { ScopedAgentContext } from '@/lib/db/scoped-agent';

/**
 * The audience snapshot — the table the whole thesis rests on.
 *
 * Writing an item and its snapshot must be atomic, so both happen inside one
 * `SECURITY DEFINER` function (`write_memory_item`, migration 0010). An item
 * whose snapshot failed to write would have an EMPTY audience, which under the
 * surfacing rule means it surfaces nowhere — safe, but invisible, and an item
 * that can never be retrieved is silent data loss.
 *
 * The snapshot is taken from live membership at the instant of the write, and
 * is immutable afterwards. A member leaving later does not shrink it, because
 * they *did* hear the thing (D-006).
 */

export interface LearnParams {
  subjectUserId: string;
  originMessageId: string | null;
  content: string;
  sourceType: 'stated' | 'inferred';
  confidence: number;
  status: 'candidate' | 'active';
  expiresAt: string | null;
}

/**
 * Write one memory item with its audience snapshot.
 *
 * The clearance level is NOT passed in — it is read from the chat this context
 * is scoped to, at write time, and frozen onto the item. Letting a caller supply
 * it would allow an extraction bug to mark an exec-channel fact as level 0, and
 * the clearance floor would then wave it into every general chat. The one input
 * that must not be caller-controlled is the one the caller cannot supply.
 */
export async function learn(
  ctx: ScopedAgentContext,
  params: LearnParams,
): Promise<string | null> {
  const clearanceLevel = await ctx.clearanceLevel();

  const { data, error } = await ctx.privilegedClient().rpc('write_memory_item', {
    p_subject_user_id: params.subjectUserId,
    p_origin_chat_id: ctx.chatId,
    p_origin_message_id: params.originMessageId,
    p_content: params.content,
    p_clearance_level: clearanceLevel,
    p_source_type: params.sourceType,
    p_confidence: params.confidence,
    p_status: params.status,
    p_expires_at: params.expiresAt,
  });

  if (error) return null;
  return data as unknown as string;
}

/** Mark an item superseded by a newer one. */
export async function supersede(
  ctx: ScopedAgentContext,
  supersededId: string,
  supersededById: string,
): Promise<void> {
  await ctx
    .privilegedClient()
    .from('memory_items')
    .update({ status: 'superseded', superseded_by: supersededById })
    .eq('id', supersededId);
}

/**
 * The containment predicate, in TypeScript.
 *
 * The authoritative implementation is SQL — this exists to make the rule
 * readable and unit-testable in isolation, and it carries the same fail-closed
 * guard, because the trap it avoids is a property of the RULE and not of any
 * one language.
 *
 * "Every active member of C2 was in the snapshot" is VACUOUSLY TRUE when C2 has
 * no active members: `Array.every` over an empty array returns true, exactly as
 * `NOT EXISTS` over an empty set does in SQL. Without the explicit zero check, a
 * vacated chat would match every item in the system.
 */
export function audienceContains(
  snapshot: ReadonlySet<string>,
  activeMembers: readonly string[],
): boolean {
  if (activeMembers.length === 0) return false;
  return activeMembers.every((id) => snapshot.has(id));
}
