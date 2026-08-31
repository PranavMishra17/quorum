import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/db/server';
import { SHOWCASE_USERS, showcaseAccountPassword } from '@/lib/auth/showcase-users';

/**
 * Showcase sign-in — always on, not gated by `NODE_ENV`.
 *
 * This is the one deliberate exception to "no unauthenticated route hands out
 * a session" (see `app/auth/dev/route.ts`'s three-gate closure, which this
 * route does NOT use). The difference that makes it acceptable:
 *
 *   1. Exactly two accounts, hardcoded here — not an open list, not anything
 *      derived from a request parameter beyond picking one of two keys.
 *   2. Both are ordinary authenticated users under full RLS. Nothing here
 *      grants elevated privilege; it is the same `signInWithPassword` a real
 *      user's password login would use.
 *   3. Every other member of every room these accounts are in is itself a
 *      seeded identity (`scripts/seed-showcase-accounts.mjs`), never a real
 *      person — so the blast radius of "anyone can act as Jordan or Morgan"
 *      is contained to a world built to be shown, not a real user's data.
 *
 * Closed by absence, not by environment: with no `SHOWCASE_ACCOUNT_PASSWORD`
 * configured (a fresh clone) this 404s rather than 500s, for the same reason
 * `app/auth/dev/route.ts` 404s when disabled — a probe should not be able to
 * tell "not configured" from "does not exist".
 */
export async function GET(request: NextRequest) {
  const password = showcaseAccountPassword();
  if (!password) {
    return new NextResponse('Not found', { status: 404 });
  }

  const key = request.nextUrl.searchParams.get('user')?.toLowerCase() ?? '';
  const user = SHOWCASE_USERS.find((u) => u.key === key);
  if (!user) {
    return NextResponse.json(
      { error: 'unknown showcase user', available: SHOWCASE_USERS.map((u) => u.key) },
      { status: 404 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password,
  });

  if (error) {
    return NextResponse.json(
      {
        error: 'showcase sign-in failed',
        hint: 'Run `pnpm seed:showcase` to create the showcase accounts.',
        detail: error.message,
      },
      { status: 500 },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = '/people';
  url.search = '';
  return NextResponse.redirect(url, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
