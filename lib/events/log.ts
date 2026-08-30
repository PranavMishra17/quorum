import type { ScopedAgentContext } from '@/lib/db/scoped-agent';
import type { AgentEventPayload, AgentEventType } from './types';

/**
 * The append-only `agent_events` writer.
 *
 * Insert only. There is no update and no delete, here or in the database — no
 * client policy admits either, and nothing in this module offers them. An audit
 * trail that can be rewritten is not an audit trail.
 *
 * Every write takes its chat, turn and request ids from the ScopedAgentContext
 * rather than from arguments, so an event cannot be attributed to a turn other
 * than the one that is actually running.
 */
export async function logEvent(
  ctx: ScopedAgentContext,
  eventType: AgentEventType,
  payload: AgentEventPayload = {},
  messageId?: string,
): Promise<void> {
  const { error } = await ctx
    .privilegedClient()
    .from('agent_events')
    .insert({
      chat_id: ctx.chatId,
      turn_id: ctx.turnId,
      request_id: ctx.requestId,
      message_id: messageId ?? null,
      event_type: eventType,
      // Payload shapes are open by design (a new event type is not a
      // migration), so the generated Json type is satisfied at the boundary
      // rather than by narrowing every event's payload.
      payload: payload as never,
    });

  if (error) {
    // A failed event write must NOT fail the turn. Losing a log line is bad;
    // dropping a user's reply because a log line could not be written is worse.
    // It is surfaced loudly instead, with the ids needed to find the gap.
    console.error('[events] write failed', {
      chatId: ctx.chatId,
      turnId: ctx.turnId,
      eventType,
      code: error.code,
      message: error.message,
    });
  }
}

/**
 * Time a step and log it with its duration in one call.
 *
 * The reason step boundaries are a single event carrying `duration_ms`, rather
 * than a `_started` / `_completed` pair: one insert instead of two, and the
 * internal view can render a timeline without a self-join.
 */
export async function logTimed<T>(
  ctx: ScopedAgentContext,
  eventType: AgentEventType,
  fn: () => Promise<T>,
  payloadFor: (result: T, durationMs: number) => AgentEventPayload,
): Promise<T> {
  const started = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - started);
  await logEvent(ctx, eventType, payloadFor(result, durationMs));
  return result;
}
