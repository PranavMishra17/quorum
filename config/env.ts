import { z } from 'zod';

/**
 * Environment validation.
 *
 * Two separate schemas, and the split is a security boundary, not tidiness:
 * anything in `clientEnv` ships in the browser bundle. If a secret ever ends
 * up there, it is public. The `NEXT_PUBLIC_` prefix is Next.js's mechanism for
 * this; the schema split is the check that we used it correctly.
 *
 * Server env is validated lazily (on first access) rather than at import time,
 * so that `next build` and the test runner do not need production secrets.
 */

// ---------------------------------------------------------------------------
// Client — SAFE TO SHIP TO THE BROWSER
// ---------------------------------------------------------------------------

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  /**
   * Supabase's publishable (formerly "anon") key. Safe in the browser BECAUSE
   * row-level security is on for every table. If RLS is ever disabled on a
   * table, this key becomes a full read of that table. That is the entire
   * reason "RLS on every table, no exceptions" is a hard rule in CLAUDE.md.
   */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

export type ClientEnv = z.infer<typeof clientSchema>;

let clientCache: ClientEnv | null = null;

/**
 * Lazy, not module-load, so that importing a threshold from `@/config` does not
 * drag an environment requirement along with it. Tests and `next build` should
 * not need production secrets to read a number out of `agent.ts`.
 *
 * Note these are inlined by Next at BUILD time — they must be referenced as
 * full literal `process.env.NEXT_PUBLIC_*` expressions for that to work.
 */
export function clientEnv(): ClientEnv {
  if (clientCache) return clientCache;
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Invalid or missing public environment variables: ${missing}. ` +
        `Copy .env.example to .env.local and fill it in — see docs/SETUP-SUPABASE.md.`,
    );
  }
  clientCache = parsed.data;
  return clientCache;
}

// ---------------------------------------------------------------------------
// Server — NEVER IMPORT FROM A CLIENT COMPONENT
// ---------------------------------------------------------------------------

const serverSchema = z.object({
  /**
   * Supabase secret (formerly "service role") key. Bypasses RLS entirely.
   * May only be read inside lib/db/scoped-agent.ts. Any other import site is
   * a bug — see the non-negotiables in CLAUDE.md.
   */
  SUPABASE_SECRET_KEY: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),

  /** Optional web-search provider. Absent = the search tool is unavailable. */
  SEARCH_API_KEY: z.string().min(1).optional(),

  /**
   * Optional embedding provider. Anthropic does not ship an embeddings API,
   * so semantic memory ranking needs a separate provider or a local model.
   * This is an open decision — see research track R3.
   */
  EMBEDDING_API_KEY: z.string().min(1).optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/** Throws on first call if server env is incomplete. Never call from the client. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Invalid or missing server environment variables: ${missing}. ` +
        `Copy .env.example to .env.local and fill it in — see docs/SETUP-SUPABASE.md.`,
    );
  }
  cached = parsed.data;
  return cached;
}
