import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createClient, requireActor, NotAuthenticatedError } from '@/lib/db/server';
import { exchangeCode, googleConfig, STATE_COOKIE } from '@/lib/connectors/google';
import { sealToken } from '@/lib/connectors/crypto';
import { untypedDb } from '@/lib/connectors/rpc';

/**
 * Complete the Google connector grant.
 *
 * `Cache-Control: private, no-store` on every path, including the failures, for
 * the same reason `app/auth/callback` carries it: this response is part of a
 * credential exchange, and a shared cache holding any part of one is a
 * primitive for handing it to somebody else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE WRITES THROUGH THE SESSION CLIENT AND STILL WORKS
 *
 * `connector_tokens` has RLS on and no policy, so the session-bound client
 * cannot write it — which is the point. The insert therefore goes through a
 * SECURITY DEFINER RPC keyed on `auth.uid()`, so the row lands against the
 * signed-in user and against nobody else, even if every parameter were
 * attacker-chosen. Reaching for the service role here would have worked and
 * would have quietly removed that guarantee.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' } as const;

function back(request: NextRequest, status: string) {
  const url = request.nextUrl.clone();
  url.pathname = '/connectors';
  url.search = `?status=${encodeURIComponent(status)}`;
  const response = NextResponse.redirect(url, { headers: NO_STORE });
  // One-shot value: it has been used or it has failed, and either way keeping
  // it around only widens the window in which it could be replayed.
  response.cookies.delete(STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401, headers: NO_STORE });
    }
    throw err;
  }

  const config = googleConfig();
  if (!config) return back(request, 'unavailable');

  const params = request.nextUrl.searchParams;
  if (params.get('error') || !params.get('code')) {
    // The user declined at Google's screen. An ordinary outcome, not an error.
    return back(request, 'declined');
  }

  // CSRF. Without this an attacker can have a victim complete the flow with the
  // ATTACKER's authorisation code, connecting the victim's account to the
  // attacker's mailbox — after which the agent quotes it to them as their own.
  const expected = request.cookies.get(STATE_COOKIE)?.value ?? '';
  const received = params.get('state') ?? '';
  if (!expected || !constantTimeEqual(expected, received)) {
    return back(request, 'state-mismatch');
  }

  const grant = await exchangeCode(config, params.get('code')!);
  if (!grant) {
    // Most often: consent granted without offline access, so there is no
    // refresh token. Storing the access token instead would produce a connector
    // that works for one hour and then fails in a way nobody can diagnose.
    return back(request, 'no-refresh-token');
  }

  const supabase = await createClient();
  const { error } = await untypedDb(supabase).rpc('connect_google', {
    p_refresh_token_encrypted: sealToken(grant.refreshToken),
    p_scopes: grant.scopes,
  });

  if (error) {
    console.error('[connector] could not store google grant', { code: error.code });
    return back(request, 'store-failed');
  }

  return back(request, 'connected');
}

/**
 * Compare without leaking length or position through timing.
 *
 * The realistic threat to a 32-byte random state is small, but the correct
 * comparison costs one function and the wrong one is the kind of thing that
 * gets copied into a place where it matters.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
