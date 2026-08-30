'use client';

import { createBrowserClient } from '@supabase/ssr';
import { clientEnv } from '@/config';
import type { Database } from './types';

/**
 * The browser client. Carries the publishable key, which ships in the bundle.
 *
 * That is safe for exactly one reason: row-level security is enabled on every
 * table, so the database itself refuses rows this user may not see. Reads go
 * direct from the browser and there is no hand-written read endpoint to audit —
 * the database is the thing that has to be right.
 *
 * If RLS were ever disabled on a table, this key would make that table world-
 * readable. That is why "RLS on every table, in the creating migration" is a
 * hard rule rather than a convention.
 *
 * Writes do NOT go through here. They need idempotency, rate limiting, event
 * logging and the agent pipeline, none of which belong in the client.
 */
export function createClient() {
  const env = clientEnv();
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}
