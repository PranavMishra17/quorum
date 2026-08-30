/**
 * Typed model-call failures.
 *
 * Callers branch on `kind`, never on a message string — message text is not an
 * API and changes without warning. Every variant carries `retryable`, because
 * the single most expensive mistake in this layer is retrying something that
 * will never succeed: a spend cap returns 429 with no `retry-after` and never
 * resolves, so treating it like an ordinary rate limit burns the whole retry
 * budget and then fails anyway.
 */

export type LlmErrorKind =
  /** 429 with a retry-after. Backing off works. */
  | 'rate_limited'
  /** 429 from an organisation spend cap. Backing off does NOT work. */
  | 'spend_cap_reached'
  /** 529. The model is up but saturated. */
  | 'overloaded'
  /** 5xx. */
  | 'server_error'
  /** Our own wall-clock ceiling, not the provider's. */
  | 'timeout'
  /** Network-level failure before a response. */
  | 'connection'
  /** 400. A bug in our request; retrying repeats the bug. */
  | 'invalid_request'
  /** 401/403. Bad or expired key — the failure mode this project plans for. */
  | 'authentication'
  /** stop_reason === 'refusal'. HTTP 200, but the model declined. */
  | 'refusal'
  /** Response did not satisfy the schema we demanded. */
  | 'malformed_output'
  /** Request exceeded the context window. */
  | 'context_overflow';

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set([
  'rate_limited',
  'overloaded',
  'server_error',
  'timeout',
  'connection',
]);

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: LlmErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'LlmError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

interface ApiErrorShape {
  status?: number;
  headers?: Record<string, string> | { get?(name: string): string | null };
  error?: { error?: { type?: string; message?: string } };
  message?: string;
}

function header(err: ApiErrorShape, name: string): string | undefined {
  const h = err.headers;
  if (!h) return undefined;
  if (typeof (h as { get?: unknown }).get === 'function') {
    return (h as { get(n: string): string | null }).get(name) ?? undefined;
  }
  return (h as Record<string, string>)[name];
}

/**
 * Map a provider error onto the union.
 *
 * The spend-cap branch is the one that earns its keep. Anthropic signals it as
 * a 429 like any rate limit, and only the inner `error.type` distinguishes it.
 * Missing that distinction means retrying a condition that cannot clear.
 */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof Error && err.name === 'AbortError') {
    return new LlmError('timeout', 'model call exceeded its wall clock', { cause: err });
  }

  const api = err as ApiErrorShape;
  const status = api?.status;
  const innerType = api?.error?.error?.type;
  const message = api?.error?.error?.message ?? api?.message ?? 'model call failed';

  if (status === 429) {
    // No retry-after, and it never resolves on retry.
    if (innerType && /spend|billing|credit/i.test(innerType)) {
      return new LlmError('spend_cap_reached', message, { status, cause: err });
    }
    const retryAfter = header(api, 'retry-after');
    return new LlmError('rate_limited', message, {
      status,
      retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
      cause: err,
    });
  }

  if (status === 529) return new LlmError('overloaded', message, { status, cause: err });
  if (status === 401 || status === 403)
    return new LlmError('authentication', message, { status, cause: err });
  if (status === 400) {
    if (/context|too many tokens|max_tokens/i.test(message)) {
      return new LlmError('context_overflow', message, { status, cause: err });
    }
    return new LlmError('invalid_request', message, { status, cause: err });
  }
  if (typeof status === 'number' && status >= 500)
    return new LlmError('server_error', message, { status, cause: err });

  if (err instanceof Error && /fetch failed|ECONNRESET|ENOTFOUND|socket hang up/i.test(err.message)) {
    return new LlmError('connection', err.message, { cause: err });
  }

  return new LlmError('server_error', message, { status, cause: err });
}

/**
 * How long to wait before attempt N. Honours `retry-after` when the provider
 * sent one; otherwise exponential with jitter, so a burst of turns failing
 * together does not retry in lockstep.
 */
export function backoffMs(attempt: number, err: LlmError, random = Math.random): number {
  if (err.retryAfterMs) return err.retryAfterMs;
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return Math.round(base * (0.5 + random() * 0.5));
}
