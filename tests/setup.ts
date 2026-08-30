import { config } from 'dotenv';

/**
 * Test bootstrap.
 *
 * Loads `.env.local` so integration tests can reach a real Postgres. Unit
 * tests — the gate chain, conflict resolution, audience containment — must NOT
 * require any of it: the supplied Anthropic key is short-lived, and a test
 * suite that stops working when a key expires is not a test suite.
 *
 * Rule for this project: anything that needs a live model call is stubbed at
 * the `lib/llm/provider.ts` boundary, never called for real in tests.
 */
config({ path: '.env.local', quiet: true });

// The "authorization suites were skipped" warning lives in global-setup.ts,
// which runs once and writes to stderr directly — Vitest swallows console
// output from per-file setup like this one.
