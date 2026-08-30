import Anthropic from '@anthropic-ai/sdk';
import { serverEnv, tierFor, specFor, type CallPurpose, type TierConfig } from '@/config';
import { LlmError, toLlmError, backoffMs } from './errors';
import type {
  CompleteParams, CompleteResult, LlmProvider, StructuredParams, StructuredResult,
} from './provider';

/**
 * The Anthropic implementation.
 *
 * Two things here are easy to get wrong from memory and fail at RUNTIME rather
 * than compile time, which is why `config/models.ts` encodes them per model and
 * this file just reads them:
 *
 *   - On the Claude 5 family, `thinking.budget_tokens` is REMOVED and returns
 *     400. Depth is `output_config.effort`.
 *   - Claude Haiku 4.5 is the inverse: it REJECTS `effort` and uses the older
 *     `{type:'enabled', budget_tokens:N}` thinking shape.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  client = new Anthropic({
    apiKey: serverEnv().ANTHROPIC_API_KEY,
    // The SDK retries twice by default. Left on, that compounds with our own
    // retry loop: a rate-limited judge call would burn three attempts against a
    // 20s ceiling while TierConfig.maxRetries claims one. We own the policy.
    maxRetries: 0,
  });
  return client;
}

/** Translate a tier into the request fields that tier's model actually accepts. */
function requestShape(tier: TierConfig) {
  const shape: Record<string, unknown> = {
    model: tier.model,
    max_tokens: tier.maxTokens,
  };

  if (tier.effort) {
    shape.output_config = { effort: tier.effort };
  }

  if (tier.thinking.kind === 'adaptive') {
    shape.thinking = { type: 'adaptive', display: tier.thinking.display };
  } else if (tier.thinking.kind === 'budget') {
    shape.thinking = { type: 'enabled', budget_tokens: tier.thinking.budgetTokens };
  }
  // 'off' omits the parameter entirely, which is what pre-5 models expect.

  return shape;
}

/**
 * Our retry loop. `TierConfig.maxRetries` is the TOTAL number of extra
 * attempts, not a number layered on top of the SDK's own.
 */
async function withRetry<T>(
  tier: TierConfig,
  purpose: CallPurpose,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: LlmError | null = null;
  for (let attempt = 0; attempt <= tier.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (raw) {
      const err = toLlmError(raw);
      lastError = err;
      // Non-retryable includes spend_cap_reached, which looks like a rate limit
      // and never clears. Failing fast is the correct behaviour.
      if (!err.retryable || attempt === tier.maxRetries) throw err;
      await new Promise((r) => setTimeout(r, backoffMs(attempt, err)));
    }
  }
  throw lastError ?? new LlmError('server_error', `no attempt made for ${purpose}`);
}

function textOf(content: unknown[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Our own wall clock, independent of the SDK's. */
function timeoutSignal(tier: TierConfig, external?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(tier.timeoutMs);
  return external ? AbortSignal.any([external, timer]) : timer;
}

export class AnthropicProvider implements LlmProvider {
  async complete(params: CompleteParams): Promise<CompleteResult> {
    const tier = tierFor(params.purpose);
    const spec = specFor(params.purpose);

    return withRetry(tier, params.purpose, async () => {
      const request = {
        ...requestShape(tier),
        system: params.system,
        messages: params.messages,
      } as Parameters<Anthropic['messages']['create']>[0];
      const options = { signal: timeoutSignal(tier, params.signal) };

      // Tiers with a large max_tokens MUST use the streaming transport, or the
      // request hits the SDK's HTTP timeout before the model finishes. This is
      // not a UX feature — no partial output reaches a user here — it is what
      // makes a long reply possible at all. `config/models.ts` marks which
      // tiers need it, and tests/config.test.ts asserts the flag is set
      // wherever max_tokens is large.
      const response = tier.stream
        ? await getClient().messages.stream(request, options).finalMessage()
        : await getClient().messages.create(request, options);

      const msg = response as unknown as {
        content: unknown[];
        stop_reason: string | null;
        usage: { input_tokens: number; output_tokens: number };
      };

      // HTTP 200, but the model declined. Always check before reading content.
      if (msg.stop_reason === 'refusal') {
        throw new LlmError('refusal', 'the model declined this request');
      }

      return {
        text: textOf(msg.content),
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
        },
        model: spec.id,
        stopReason: msg.stop_reason,
      };
    });
  }

  async structured<T>(params: StructuredParams<T>): Promise<StructuredResult<T>> {
    const tier = tierFor(params.purpose);
    const spec = specFor(params.purpose);

    return withRetry(tier, params.purpose, async () => {
      const shape = requestShape(tier);
      // effort and format share output_config, so merge rather than overwrite.
      shape.output_config = {
        ...(shape.output_config as Record<string, unknown> | undefined),
        format: { type: 'json_schema', schema: params.schema },
      };

      const response = await getClient().messages.create(
        {
          ...shape,
          system: params.system,
          messages: params.messages,
        } as Parameters<Anthropic['messages']['create']>[0],
        { signal: timeoutSignal(tier, params.signal) },
      );

      const msg = response as unknown as {
        content: unknown[];
        stop_reason: string | null;
        usage: { input_tokens: number; output_tokens: number };
      };

      if (msg.stop_reason === 'refusal') {
        throw new LlmError('refusal', 'the model declined this request');
      }

      const text = textOf(msg.content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LlmError('malformed_output', 'response was not valid JSON');
      }

      // Schema-valid is not the same as correct. The caller's predicate is the
      // real gate, and anything that fails it is treated as a failed call
      // rather than quietly coerced.
      if (!params.validate(parsed)) {
        throw new LlmError('malformed_output', 'response did not satisfy the caller contract');
      }

      return {
        text,
        value: parsed,
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
        },
        model: spec.id,
        stopReason: msg.stop_reason,
      };
    });
  }
}

/** Reset between tests. */
export function __resetClientForTests(): void {
  client = null;
}
