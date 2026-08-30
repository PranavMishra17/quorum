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
 * Whether the public Supabase settings are present.
 *
 * Lets the app render a setup page instead of a stack trace when someone clones
 * the repo and runs `pnpm dev` before provisioning anything. A missing
 * configuration is an ordinary state on a fresh checkout, not an exception.
 */
export function isConfigured(): boolean {
  return clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  }).success;
}

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

/**
 * An optional secret that may legitimately be BLANK.
 *
 * `.optional()` admits `undefined` — it does NOT admit `''`. A key declared in
 * `.env.example` as `SEARCH_API_KEY=` is *present and empty*, which fails
 * `.min(1)` and takes the whole schema down with it.
 *
 * That is not hypothetical. Copying `.env.example` to `.env.local` — the exact
 * step the setup docs instruct — made `serverEnv()` throw, and because the
 * agent turn resolves env lazily inside `after()`, EVERY TURN DIED SILENTLY
 * with the user's message already persisted and no reply ever arriving. A blank
 * optional key disabled the entire agent.
 *
 * So blank is normalised to absent, which is what "optional" was always meant
 * to mean here.
 */
const optionalSecret = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const serverSchema = z.object({
  /**
   * Supabase secret (formerly "service role") key. Bypasses RLS entirely.
   * May only be read inside lib/db/scoped-agent.ts. Any other import site is
   * a bug — see the non-negotiables in CLAUDE.md.
   */
  SUPABASE_SECRET_KEY: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),

  /** Optional web-search provider. Absent = the search tool is unavailable. */
  SEARCH_API_KEY: optionalSecret,

  /**
   * Optional embedding provider. Anthropic does not ship an embeddings API,
   * so semantic memory ranking needs a separate provider or a local model.
   * This is an open decision — see research track R3.
   */
  EMBEDDING_API_KEY: optionalSecret,

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/**
 * Parse an environment object. Pure, uncached, and exported so the rules above
 * can be tested directly — a cached singleton reading `process.env` is
 * effectively untestable, which is part of why the blank-key bug survived to
 * production-like use.
 */
export function parseServerEnv(source: NodeJS.ProcessEnv): ServerEnv {
  const parsed = serverSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Invalid or missing server environment variables: ${missing}. ` +
        `Copy .env.example to .env.local and fill it in — see docs/SETUP-SUPABASE.md.`,
    );
  }
  return parsed.data;
}

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
