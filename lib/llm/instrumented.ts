import { estimateCost, tierFor, specFor, PURPOSE_TIER } from '@/config';
import type { ScopedAgentContext } from '@/lib/db/scoped-agent';
import { logEvent } from '@/lib/events/log';
import { toLlmError } from './errors';
import type {
  CompleteParams, CompleteResult, LlmProvider, StructuredParams, StructuredResult, Usage,
} from './provider';

/**
 * Wraps a provider so that every model call is accounted for.
 *
 * THE ROW IS WRITTEN BEFORE THE NETWORK CALL, NOT AFTER.
 *
 * That ordering is the whole design. A row written only on success is missing
 * exactly when it matters most: if the process dies between "Anthropic charged
 * us" and "row inserted", there is no trace, and the retry pays a second time.
 * An accounting system that records only successes understates the bill in
 * precisely the failure cases you most want to see.
 *
 * It is also why `llm_calls` has `status` and `started_at`/`finished_at` rather
 * than a `latency_ms` column — a duration cannot be written before the call
 * returns, so a schema with only `latency_ms` forces write-after-return.
 *
 * Instrumentation lives here rather than in `anthropic.ts` so that swapping the
 * provider does not disturb the accounting, and vice versa.
 */
export function instrument(
  provider: LlmProvider,
  ctx: ScopedAgentContext,
  messageId?: string,
): LlmProvider {
  async function begin(purpose: keyof typeof PURPOSE_TIER): Promise<string | null> {
    const tier = tierFor(purpose);
    const { data, error } = await ctx
      .privilegedClient()
      .from('llm_calls')
      .insert({
        chat_id: ctx.chatId,
        turn_id: ctx.turnId,
        request_id: ctx.requestId,
        message_id: messageId ?? null,
        model: specFor(purpose).id,
        tier: PURPOSE_TIER[purpose],
        purpose,
        status: 'started',
      })
      .select('id')
      .single();

    if (error) {
      // Accounting must not take the turn down. The call still happens; the
      // gap is made loud instead of silent.
      console.error('[llm] could not open a call record', {
        chatId: ctx.chatId, turnId: ctx.turnId, purpose, code: error.code,
      });
      return null;
    }

    const id = (data as { id: string }).id;
    await logEvent(ctx, 'model_call_started', {
      purpose, model: specFor(purpose).id, tier: PURPOSE_TIER[purpose], llm_call_id: id,
    }, messageId);
    return id;
  }

  async function succeed(
    id: string | null,
    purpose: keyof typeof PURPOSE_TIER,
    usage: Usage,
    startedAt: number,
  ) {
    const cost = estimateCost(tierFor(purpose).model, usage.inputTokens, usage.outputTokens);
    const durationMs = Math.round(performance.now() - startedAt);
    if (id) {
      await ctx.privilegedClient().from('llm_calls').update({
        status: 'succeeded',
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cost_estimate: cost,
        finished_at: new Date().toISOString(),
      }).eq('id', id);
    }
    await logEvent(ctx, 'model_call_succeeded', {
      purpose, model: specFor(purpose).id, tier: PURPOSE_TIER[purpose],
      llm_call_id: id, duration_ms: durationMs,
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      cost_estimate: cost,
    }, messageId);
  }

  async function fail(
    id: string | null,
    purpose: keyof typeof PURPOSE_TIER,
    raw: unknown,
    startedAt: number,
  ) {
    const err = toLlmError(raw);
    const durationMs = Math.round(performance.now() - startedAt);
    if (id) {
      await ctx.privilegedClient().from('llm_calls').update({
        status: 'failed',
        error_type: err.kind,
        finished_at: new Date().toISOString(),
      }).eq('id', id);
    }
    await logEvent(ctx, 'model_call_failed', {
      purpose, model: specFor(purpose).id, tier: PURPOSE_TIER[purpose],
      llm_call_id: id, duration_ms: durationMs, error_kind: err.kind,
    }, messageId);

    // Two failures deserve their own event type: a refusal is a product
    // outcome, and a spend cap is an operational emergency. Neither should be
    // discoverable only by filtering model_call_failed by a payload field.
    if (err.kind === 'refusal') {
      await logEvent(ctx, 'refusal', { purpose, model: specFor(purpose).id }, messageId);
    }
    if (err.kind === 'spend_cap_reached') {
      await logEvent(ctx, 'spend_cap_reached', { purpose }, messageId);
    }
    throw err;
  }

  return {
    async complete(params: CompleteParams): Promise<CompleteResult> {
      const id = await begin(params.purpose);
      const startedAt = performance.now();
      try {
        const result = await provider.complete(params);
        await succeed(id, params.purpose, result.usage, startedAt);
        return result;
      } catch (err) {
        await fail(id, params.purpose, err, startedAt);
        throw err; // unreachable; fail() rethrows
      }
    },

    async structured<T>(params: StructuredParams<T>): Promise<StructuredResult<T>> {
      const id = await begin(params.purpose);
      const startedAt = performance.now();
      try {
        const result = await provider.structured(params);
        await succeed(id, params.purpose, result.usage, startedAt);
        return result;
      } catch (err) {
        await fail(id, params.purpose, err, startedAt);
        throw err;
      }
    },
  };
}
