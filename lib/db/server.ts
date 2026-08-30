import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { clientEnv } from '@/config';

/**
 * The session-bound server client.
 *
 * Acts AS THE USER: it carries their session, so every query it makes is
 * subject to the same row-level security a browser query would be. This is the
 * client for everything a user does. `lib/db/scoped-agent.ts` — the only
 * service-role site — is exclusively for inside an agent turn.
 *
 * Reach for this by default. Reaching for the scoped-agent client to "make a
 * query work" is how a two-axis authorisation model quietly becomes a
 * one-axis one.
 */
export async function createClient() {
  const env = clientEnv();
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Harmless: `proxy.ts` refreshes the session on every request, so
            // the write that matters has already happened.
          }
        },
      },
    },
  );
}

export interface Actor {
  id: string;
  email: string | null;
}

/**
 * Resolve the acting user for an authorisation decision.
 *
 * `getClaims()`, never `getSession()`. Supabase is explicit that `getSession()`
 * must not be trusted server-side because it does not revalidate — it returns
 * whatever is in the cookie. An authorisation decision made on it would be
 * running on a claim Supabase itself would reject.
 *
 * Returns null rather than throwing: "not signed in" is an ordinary state, and
 * every caller has to handle it anyway.
 */
export async function getActor(): Promise<Actor | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return {
    id: data.claims.sub,
    email: (data.claims.email as string | undefined) ?? null,
  };
}

/**
 * The same, but for route handlers that cannot proceed without an actor.
 * Throws a typed error the handler maps to a 401.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('not authenticated');
    this.name = 'NotAuthenticatedError';
  }
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new NotAuthenticatedError();
  return actor;
}
