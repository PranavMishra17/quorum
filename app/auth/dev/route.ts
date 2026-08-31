import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/db/server';
import { ensureProfile } from '@/lib/auth/profile';
import { ensureDemoWorld } from '@/lib/demo/seed';
import { DEV_USERS, DEV_PASSWORD, devLoginEnabled } from '@/lib/auth/dev-users';

/**
 * Development-only sign-in.
 *
 * Authorisation is the graded axis of this project and demonstrating it needs
 * three or more distinct identities in overlapping chats with different
 * clearances. Doing that through real Google OAuth means three browser profiles
 * and a lot of clicking, which makes the most important thing to demonstrate
 * the most tedious thing to demonstrate.
 *
 * ---------------------------------------------------------------------------
 * THE GATE
 *
 * This route is the single most dangerous file in the repository: it hands out
 * sessions. It is therefore closed in three independent ways, and it 404s —
 * rather than 403s — so a probe cannot even confirm it exists:
 *
 *   1. NODE_ENV must not be 'production'.
 *   2. ALLOW_DEV_LOGIN must be explicitly 'true' — opt-in, never a default.
 *   3. The requested user must be one of the fixed seeded accounts.
 *
 * `devLoginEnabled()` is asserted by tests/auth/dev-login-gate.test.ts, and
 * scripts/check-boundaries.mjs fails the build if this file ever loses its
 * NODE_ENV check.
 */
export async function GET(request: NextRequest) {
  if (!devLoginEnabled()) {
    return new NextResponse('Not found', { status: 404 });
  }

  const key = request.nextUrl.searchParams.get('user')?.toLowerCase() ?? '';
  const user = DEV_USERS.find((u) => u.key === key);
  if (!user) {
    return NextResponse.json(
      { error: 'unknown dev user', available: DEV_USERS.map((u) => u.key) },
      { status: 404 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: DEV_PASSWORD,
  });

  if (error) {
    return NextResponse.json(
      {
        error: 'dev sign-in failed',
        hint: 'Run `pnpm seed:dev` to create the seeded accounts.',
        detail: error.message,
      },
      { status: 500 },
    );
  }

  await ensureProfile();
  await ensureDemoWorld();

  const url = request.nextUrl.clone();
  url.pathname = '/chats';
  url.search = '';
  return NextResponse.redirect(url, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
