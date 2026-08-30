import { MEMORY } from '@/config';
import type { ScopedAgentContext } from '@/lib/db/scoped-agent';
import { logEvent } from '@/lib/events/log';

/**
 * THE ONLY PLACE MEMORY IS QUERIED.
 *
 * Enforced by `pnpm check:boundaries`, which fails the build if a memory table
 * is named anywhere outside `lib/memory/`. One filter path means one place to
 * audit and one place to test.
 *
 * ---------------------------------------------------------------------------
 * FILTER → RANK → CAP, and the order is the design
 *
 * The filter runs in SQL, inside `private.memory_visible_in_chat()`, before a
 * single row reaches TypeScript. Everything in this file operates on an
 * already-authorised set.
 *
 * Retrieving the top 20 by relevance and then discarding the unauthorised 5 is
 * a different program with the same output most of the time, and a leak the
 * rest of the time. Authorisation is not a relevance-ranking problem.
 *
 * The practical consequence: nothing below can cause a leak. Change the weights
 * however you like; the worst outcome is a worse answer, never a wrong audience.
 */

export interface RetrievedItem {
  id: string;
  subjectUserId: string;
  content: string;
  sourceType: 'stated' | 'inferred';
  confidence: number;
  createdAt: string;
  /** Combined score. Ordering only — never compared across turns. */
  score: number;
}

export interface RetrievalResult {
  items: RetrievedItem[];
  /**
   * Removed by the AUTHORISATION filter. This number is the whole point of the
   * internal view: a filter you cannot see working is indistinguishable from
   * one that is not running.
   */
  filteredOut: number;
  /** Removed by the caps. Kept separate — this is budget, not authorisation. */
  cappedOut: number;
}

interface Row {
  id: string;
  subject_user_id: string;
  content: string;
  clearance_level: number;
  source_type: 'stated' | 'inferred';
  confidence: number;
  created_at: string;
  relevance: number;
}

/**
 * Exponential decay with a configured half-life. Returns 1 for something learned
 * now, 0.5 at the half-life, approaching 0 thereafter.
 */
export function recencyScore(createdAt: string, now: Date): number {
  const ageDays = (now.getTime() - new Date(createdAt).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / MEMORY.retrieval.recencyHalfLifeDays);
}

/**
 * Rank an already-authorised set.
 *
 * Exported and pure so it can be tested without a database — the filter is what
 * needs a real Postgres, and it is tested there.
 */
export function rank(
  rows: Row[],
  opts: { now: Date; recentSpeakers: Set<string> },
): RetrievedItem[] {
  const w = MEMORY.retrieval.weights;
  return rows
    .map((r) => ({
      id: r.id,
      subjectUserId: r.subject_user_id,
      content: r.content,
      sourceType: r.source_type,
      confidence: r.confidence,
      createdAt: r.created_at,
      score:
        w.relevance * r.relevance +
        w.recency * recencyScore(r.created_at, opts.now) +
        // A fact about someone who just spoke is far more likely to matter than
        // one about a person who has not appeared in the conversation.
        w.speakerPresence * (opts.recentSpeakers.has(r.subject_user_id) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Two caps, and they do different jobs.
 *
 * The per-subject cap exists because in a twenty-person group one
 * heavily-discussed member would otherwise fill the entire budget and the other
 * nineteen would be invisible. Applying it before the global cap is what makes
 * the budget spread across people rather than concentrate on one.
 */
export function cap(items: RetrievedItem[]): { kept: RetrievedItem[]; cappedOut: number } {
  const perSubject = new Map<string, number>();
  const kept: RetrievedItem[] = [];

  for (const item of items) {
    if (kept.length >= MEMORY.retrieval.globalItemCap) break;
    const used = perSubject.get(item.subjectUserId) ?? 0;
    if (used >= MEMORY.retrieval.perSubjectCap) continue;
    perSubject.set(item.subjectUserId, used + 1);
    kept.push(item);
  }

  return { kept, cappedOut: items.length - kept.length };
}

/**
 * Retrieve what may surface in this chat, for this message.
 *
 * `ctx` supplies the scope. There is deliberately no `chatId` parameter — that
 * is the ScopedAgentContext invariant, and it is what stops model-controlled
 * tool input redirecting a memory read at another chat.
 */
export async function retrieveMemory(
  ctx: ScopedAgentContext,
  params: { query: string; recentSpeakerIds: string[] },
): Promise<RetrievalResult> {
  const startedAt = performance.now();

  // The authorisation filter. Everything after this line is already authorised.
  const { data, error } = await ctx
    .privilegedClient()
    .rpc('memory_for_chat', { p_chat_id: ctx.chatId, p_query: params.query });

  if (error) {
    // Fail CLOSED. Retrieval is an enhancement; the turn proceeds without it.
    // Silently returning partial memory would be worse than returning none.
    await logEvent(ctx, 'memory_retrieved', {
      kept: 0, filtered_out: 0, capped_out: 0, error: error.message,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return { items: [], filteredOut: 0, cappedOut: 0 };
  }

  const authorised = (data ?? []) as Row[];

  // How many items EXIST about the people in this chat, before authorisation.
  // Reported so the internal view can show the filter doing work — the
  // difference between this and `kept` is the leak that did not happen.
  const total = await countCandidates(ctx);
  const filteredOut = Math.max(0, total - authorised.length);

  const relevant = authorised.filter(
    (r) => r.relevance >= MEMORY.retrieval.relevanceFloor || r.relevance === 0,
  );

  const ranked = rank(relevant, {
    now: new Date(),
    recentSpeakers: new Set(params.recentSpeakerIds),
  });
  const { kept, cappedOut } = cap(ranked);

  await logEvent(ctx, 'memory_retrieved', {
    kept: kept.length,
    filtered_out: filteredOut,
    capped_out: cappedOut,
    duration_ms: Math.round(performance.now() - startedAt),
  });

  return { items: kept, filteredOut, cappedOut };
}

/**
 * Total active items about anyone currently in this chat, ignoring
 * authorisation. Used only to report how many the filter removed.
 *
 * This is a deliberate, narrow exception to "never read memory unfiltered": it
 * reads a COUNT and never content, and the count exists so a human can see the
 * rule working. Without it the internal view can only say "3 items surfaced",
 * which is indistinguishable from "no filter is running".
 */
async function countCandidates(ctx: ScopedAgentContext): Promise<number> {
  const memberIds = await ctx.activeMemberIds();
  if (memberIds.length === 0) return 0;

  const { count, error } = await ctx
    .privilegedClient()
    .from('memory_items')
    .select('id', { count: 'exact', head: true })
    .in('subject_user_id', memberIds)
    .eq('status', 'active');

  return error || count === null ? 0 : count;
}
