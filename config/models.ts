/**
 * Model tier registry.
 *
 * Nothing in the application names a model string directly. Code names a
 * PURPOSE; a purpose maps to a TIER; a tier maps to a MODEL + call settings.
 * That indirection is the reason a dead key, a rate limit, or a cost problem
 * is a one-file change rather than a grep-and-pray.
 *
 * Every field here is also what gets written to the `llm_calls` row, so the
 * cost dashboard and the agent internal view are reading the same source of
 * truth the caller used.
 *
 * API-shape notes that this file deliberately encodes (they are easy to get
 * wrong from memory):
 *   - On the Claude 5 family, `thinking.budget_tokens` is REMOVED and returns
 *     400. Depth is controlled by `output_config.effort` instead. The old
 *     "thinking budget" concept maps onto `effort`, not onto a token count.
 *   - Claude Opus 5 runs adaptive thinking BY DEFAULT (unlike Opus 4.8/4.7).
 *   - Claude Haiku 4.5 is a pre-5 model: it does NOT accept `effort` (errors),
 *     and its thinking is the older `{type:"enabled", budget_tokens:N}` shape.
 *   - Large `max_tokens` must stream, or the request hits the HTTP timeout.
 */

export type ModelTier = 'reflex' | 'judge' | 'converse' | 'reason';

/** `output_config.effort` — the Claude 5-family replacement for thinking budgets. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ThinkingMode =
  /** Claude 5 family: adaptive thinking, no token budget. */
  | { kind: 'adaptive'; display: 'omitted' | 'summarized' }
  /** Pre-5 models only (e.g. Haiku 4.5): explicit token budget. */
  | { kind: 'budget'; budgetTokens: number }
  | { kind: 'off' };

export interface ModelSpec {
  id: string;
  contextWindow: number;
  /** Upper bound the provider will accept for `max_tokens`. */
  maxOutputTokens: number;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
  /** False for pre-5 models — passing `effort` to them is a 400. */
  supportsEffort: boolean;
}

/** Prices are USD per million tokens, Anthropic first-party API rates. */
export const MODELS = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricePerMTokIn: 5.0,
    pricePerMTokOut: 25.0,
    supportsEffort: true,
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricePerMTokIn: 2.0,
    pricePerMTokOut: 10.0,
    supportsEffort: true,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricePerMTokIn: 1.0,
    pricePerMTokOut: 5.0,
    supportsEffort: false,
  },
  'claude-fable-5': {
    id: 'claude-fable-5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricePerMTokIn: 10.0,
    pricePerMTokOut: 50.0,
    supportsEffort: true,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

export interface TierConfig {
  model: ModelId;
  /** Depth dial. Null on models where `effort` is rejected. */
  effort: Effort | null;
  thinking: ThinkingMode;
  maxTokens: number;
  /** Required when maxTokens is large; also what the chat UI needs. */
  stream: boolean;
  /** Hard ceiling on a single call, enforced by the provider wrapper. */
  timeoutMs: number;
  /**
   * TOTAL attempts beyond the first — not additive with the SDK's own default.
   *
   * The Anthropic SDK retries twice by default. If both layers retry, a
   * rate-limited judge call burns three attempts against a 20s ceiling while
   * this config claims one. `lib/llm/anthropic.ts` MUST construct the client
   * with `maxRetries: 0` and own the retry policy here.
   */
  maxRetries: number;
  description: string;
}

/**
 * Four tiers, ordered by cost. The rule for choosing one: pick the cheapest
 * tier whose failure mode is acceptable. A wrong `reflex` answer costs a
 * slightly worse log line; a wrong `converse` answer is the product.
 */
export const TIERS = {
  /** T0 — mechanical, high-volume, latency-critical. Never user-facing prose. */
  reflex: {
    model: 'claude-haiku-4-5',
    effort: null, // Haiku 4.5 rejects `effort`.
    thinking: { kind: 'off' },
    maxTokens: 1_024,
    stream: false,
    timeoutMs: 15_000,
    maxRetries: 1,
    description:
      'Cheap classification and short summarisation. Chat titles, tool-result compression.',
  },

  /** T1 — short structured judgements that need real reasoning but not depth. */
  judge: {
    model: 'claude-sonnet-5',
    effort: 'low',
    thinking: { kind: 'adaptive', display: 'omitted' },
    maxTokens: 1_024,
    stream: false,
    timeoutMs: 20_000,
    maxRetries: 1,
    description:
      'The response-gate judge and memory extraction. Structured output only, never prose.',
  },

  /** T2 — the actual conversational reply. The one users read. */
  converse: {
    model: 'claude-opus-5',
    effort: 'medium',
    thinking: { kind: 'adaptive', display: 'omitted' },
    maxTokens: 8_192,
    stream: true,
    timeoutMs: 120_000,
    maxRetries: 1,
    description: 'The agent speaking in a chat. Streamed.',
  },

  /** T3 — bounded multi-step reasoning. Expensive; gated behind an explicit ask. */
  reason: {
    model: 'claude-opus-5',
    effort: 'xhigh',
    thinking: { kind: 'adaptive', display: 'summarized' },
    maxTokens: 32_000,
    stream: true,
    /**
     * Deliberately under the platform invocation ceiling. At 300_000 this
     * consumed the entire Vercel budget, leaving nothing for the rest of the
     * turn — and a function killed at the ceiling cancels its own deferred
     * memory extraction.
     */
    timeoutMs: 240_000,
    maxRetries: 0,
    description:
      'Research synthesis and other deliberately deep work. User-invoked, never automatic.',
  },
} as const satisfies Record<ModelTier, TierConfig>;

/**
 * Call purposes. This is a closed set on purpose: `llm_calls.purpose` is a
 * dimension in the cost dashboard, so a free-text purpose would make the
 * dashboard useless within a day.
 */
export const PURPOSE_TIER = {
  gate_judge: 'judge',
  memory_extract: 'judge',
  memory_conflict_explain: 'judge',
  chat_response: 'converse',
  research_synthesis: 'reason',
  tool_result_summarize: 'reflex',
  chat_title: 'reflex',
} as const satisfies Record<string, ModelTier>;

export type CallPurpose = keyof typeof PURPOSE_TIER;

export function tierFor(purpose: CallPurpose): TierConfig {
  return TIERS[PURPOSE_TIER[purpose]];
}

export function specFor(purpose: CallPurpose): ModelSpec {
  return MODELS[tierFor(purpose).model];
}

/** USD. Written to `llm_calls.cost_estimate` on every call. */
export function estimateCost(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  const spec = MODELS[model];
  return (
    (inputTokens / 1_000_000) * spec.pricePerMTokIn +
    (outputTokens / 1_000_000) * spec.pricePerMTokOut
  );
}
