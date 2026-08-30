import { describe, it, expect } from 'vitest';
import { LlmError, toLlmError, backoffMs } from '@/lib/llm/errors';

/**
 * These run without an API key, deliberately. The supplied Anthropic key is
 * short-lived, and a suite that stops working when a key expires is not a suite.
 *
 * What is under test is the classification, because the expensive mistake in
 * this layer is retrying something that can never succeed.
 */

const apiError = (status: number, opts: {
  type?: string; message?: string; headers?: Record<string, string>;
} = {}) => ({
  status,
  headers: opts.headers,
  error: { error: { type: opts.type, message: opts.message ?? 'boom' } },
});

describe('classification', () => {
  it('a plain 429 is a retryable rate limit', () => {
    const err = toLlmError(apiError(429));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryable).toBe(true);
  });

  it('a 429 from a SPEND CAP is not retryable', () => {
    // The one that earns its keep. Anthropic signals a spend cap as a 429 like
    // any rate limit; only the inner error type distinguishes it, it carries no
    // retry-after, and it never clears. Treating it as an ordinary rate limit
    // burns the whole retry budget and then fails anyway.
    for (const type of ['enforced_spend_limit_reached', 'billing_error', 'credit_exhausted']) {
      const err = toLlmError(apiError(429, { type }));
      expect(err.kind, type).toBe('spend_cap_reached');
      expect(err.retryable, type).toBe(false);
    }
  });

  it('honours retry-after when the provider sends one', () => {
    const err = toLlmError(apiError(429, { headers: { 'retry-after': '7' } }));
    expect(err.retryAfterMs).toBe(7000);
  });

  it('529 is overloaded and retryable', () => {
    expect(toLlmError(apiError(529)).kind).toBe('overloaded');
    expect(toLlmError(apiError(529)).retryable).toBe(true);
  });

  it('5xx is a retryable server error', () => {
    expect(toLlmError(apiError(500)).retryable).toBe(true);
    expect(toLlmError(apiError(503)).retryable).toBe(true);
  });

  it('400 is a bug in our request, so retrying just repeats it', () => {
    const err = toLlmError(apiError(400, { message: 'invalid tool schema' }));
    expect(err.kind).toBe('invalid_request');
    expect(err.retryable).toBe(false);
  });

  it('a 400 about context length is distinguished from other 400s', () => {
    // Different remedy: trim the context rather than fix the request.
    const err = toLlmError(apiError(400, { message: 'prompt is too long: context window exceeded' }));
    expect(err.kind).toBe('context_overflow');
  });

  it('401 and 403 are authentication — the expiring-key case', () => {
    expect(toLlmError(apiError(401)).kind).toBe('authentication');
    expect(toLlmError(apiError(403)).kind).toBe('authentication');
    expect(toLlmError(apiError(401)).retryable).toBe(false);
  });

  it('an aborted call is a timeout, not a server error', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const err = toLlmError(abort);
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('network failures are retryable', () => {
    expect(toLlmError(new Error('fetch failed')).kind).toBe('connection');
    expect(toLlmError(new Error('socket hang up')).retryable).toBe(true);
  });

  it('passes an LlmError through unchanged', () => {
    const original = new LlmError('refusal', 'declined');
    expect(toLlmError(original)).toBe(original);
  });

  it('a refusal is never retryable — the model meant it', () => {
    expect(new LlmError('refusal', 'x').retryable).toBe(false);
  });

  it('malformed output is not retried blindly', () => {
    // Retrying an unparseable response usually produces another one, and it is
    // billed each time. The caller decides whether a retry is worth it.
    expect(new LlmError('malformed_output', 'x').retryable).toBe(false);
  });
});

describe('backoff', () => {
  it('prefers the provider retry-after over its own schedule', () => {
    const err = new LlmError('rate_limited', 'x', { retryAfterMs: 4321 });
    expect(backoffMs(0, err)).toBe(4321);
    expect(backoffMs(5, err)).toBe(4321);
  });

  it('grows exponentially and is capped', () => {
    const err = new LlmError('server_error', 'x');
    const noJitter = () => 1; // upper bound of the jitter range
    expect(backoffMs(0, err, noJitter)).toBe(1000);
    expect(backoffMs(1, err, noJitter)).toBe(2000);
    expect(backoffMs(2, err, noJitter)).toBe(4000);
    expect(backoffMs(9, err, noJitter)).toBe(8000); // capped
  });

  it('jitters, so simultaneous failures do not retry in lockstep', () => {
    const err = new LlmError('server_error', 'x');
    expect(backoffMs(3, err, () => 0)).toBe(4000);
    expect(backoffMs(3, err, () => 1)).toBe(8000);
  });
});
