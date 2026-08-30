import { describe, it, expect } from 'vitest';
import { parseServerEnv } from '@/config';

/**
 * Environment validation.
 *
 * These exist because of a real failure found by running the app, not by
 * reading it. `.env.example` declares the optional keys as `SEARCH_API_KEY=` —
 * present and blank. Zod's `.optional()` admits `undefined`, not `''`, so the
 * schema rejected them and `serverEnv()` threw.
 *
 * The failure mode was the worst kind. The agent turn runs inside `after()`, so
 * the user's message was persisted, the request returned 201, and no reply ever
 * arrived — nothing in the UI, and nothing in `agent_events`, because the throw
 * happened before the first event could be written. A blank optional key
 * silently disabled the entire agent.
 *
 * `parseServerEnv` is exported precisely so this is testable: a cached
 * singleton reading `process.env` is effectively untestable, which is part of
 * why the bug survived.
 */

const required = {
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
} as unknown as NodeJS.ProcessEnv;

describe('optional keys may be blank', () => {
  it('accepts BLANK optional keys — exactly what .env.example ships', () => {
    expect(() =>
      parseServerEnv({ ...required, SEARCH_API_KEY: '', EMBEDDING_API_KEY: '' }),
    ).not.toThrow();
  });

  it('normalises blank to absent rather than to an empty string', () => {
    // Downstream code does `Boolean(serverEnv().SEARCH_API_KEY)` to decide
    // whether a tool is available. '' is falsy too, but undefined is the
    // honest representation and keeps that check unambiguous.
    const env = parseServerEnv({ ...required, SEARCH_API_KEY: '' });
    expect(env.SEARCH_API_KEY).toBeUndefined();
  });

  it('treats whitespace as blank', () => {
    expect(parseServerEnv({ ...required, SEARCH_API_KEY: '   ' }).SEARCH_API_KEY)
      .toBeUndefined();
  });

  it('accepts an entirely absent optional key', () => {
    expect(() => parseServerEnv({ ...required })).not.toThrow();
  });

  it('keeps a real value intact', () => {
    expect(parseServerEnv({ ...required, SEARCH_API_KEY: 'real' }).SEARCH_API_KEY)
      .toBe('real');
  });
});

describe('required keys stay required', () => {
  it('a missing key throws and names it', () => {
    expect(() => parseServerEnv({ ANTHROPIC_API_KEY: 'x' } as unknown as NodeJS.ProcessEnv))
      .toThrow(/SUPABASE_SECRET_KEY/);
  });

  it('a BLANK required key throws rather than being waved through', () => {
    // Blank means "unset" only for keys declared optional. A blank required key
    // is a misconfiguration and must fail loudly.
    expect(() => parseServerEnv({ ...required, ANTHROPIC_API_KEY: '' }))
      .toThrow(/ANTHROPIC_API_KEY/);
  });

  it('the error names every missing key, not just the first', () => {
    expect(() => parseServerEnv({} as unknown as NodeJS.ProcessEnv))
      .toThrow(/SUPABASE_SECRET_KEY.*ANTHROPIC_API_KEY|ANTHROPIC_API_KEY.*SUPABASE_SECRET_KEY/);
  });
});
