import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_USERS, devLoginEnabled } from '@/lib/auth/dev-users';

/**
 * The dev-login route hands out sessions, which makes it the single most
 * dangerous file in the repository. These tests exist because "it's gated by
 * NODE_ENV" is the kind of claim that is true until someone refactors.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOW = process.env.ALLOW_DEV_LOGIN;

function setEnv(nodeEnv: string | undefined, allow: string | undefined) {
  // NODE_ENV is a readonly-typed property on ProcessEnv; assigning needs a cast.
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  (process.env as Record<string, string | undefined>).ALLOW_DEV_LOGIN = allow;
}

afterEach(() => setEnv(ORIGINAL_NODE_ENV, ORIGINAL_ALLOW));

describe('dev login is closed by default', () => {
  it('is DISABLED in production even when explicitly allowed', () => {
    setEnv('production', 'true');
    expect(devLoginEnabled()).toBe(false);
  });

  it('is DISABLED in development unless explicitly opted in', () => {
    // Opt-in, not opt-out: forgetting to set something must never be what
    // opens the door.
    setEnv('development', undefined);
    expect(devLoginEnabled()).toBe(false);
    setEnv('development', 'false');
    expect(devLoginEnabled()).toBe(false);
    setEnv('development', '1');
    expect(devLoginEnabled()).toBe(false);
    setEnv('development', 'TRUE');
    expect(devLoginEnabled()).toBe(false); // exact string only
  });

  it('is enabled only with both conditions met', () => {
    setEnv('development', 'true');
    expect(devLoginEnabled()).toBe(true);
  });

  it('is disabled in the test environment by default', () => {
    setEnv('test', undefined);
    expect(devLoginEnabled()).toBe(false);
  });
});

describe('the route itself keeps its guard', () => {
  const SOURCE = readFileSync(
    join(process.cwd(), 'app', 'auth', 'dev', 'route.ts'),
    'utf8',
  );

  it('checks devLoginEnabled() before doing anything else', () => {
    const body = SOURCE.slice(SOURCE.indexOf('export async function GET'));
    const guardAt = body.indexOf('devLoginEnabled()');
    const signInAt = body.indexOf('signInWithPassword');
    expect(guardAt).toBeGreaterThan(-1);
    expect(signInAt).toBeGreaterThan(-1);
    expect(guardAt, 'the gate must precede the sign-in').toBeLessThan(signInAt);
  });

  it('404s rather than 403s, so a probe cannot confirm the route exists', () => {
    expect(SOURCE).toMatch(/status:\s*404/);
  });

  it('only ever signs in a fixed, known account', () => {
    // No arbitrary email from the query string.
    expect(SOURCE).toMatch(/DEV_USERS\.find/);
    expect(SOURCE).not.toMatch(/searchParams\.get\(['"]email['"]\)/);
  });
});

describe('the seeded cast demonstrates the authorisation model', () => {
  it('includes someone with NO clearance — the axis-independence demo', () => {
    expect(DEV_USERS.some((u) => u.clearance === null)).toBe(true);
  });

  it('includes users at different rungs, so the floor is observable', () => {
    const levels = new Set(DEV_USERS.map((u) => u.clearance));
    expect(levels.size).toBeGreaterThanOrEqual(4);
  });

  it('has unique keys and emails', () => {
    expect(new Set(DEV_USERS.map((u) => u.key)).size).toBe(DEV_USERS.length);
    expect(new Set(DEV_USERS.map((u) => u.email)).size).toBe(DEV_USERS.length);
  });
});
