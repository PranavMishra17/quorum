import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/db/server';
import { ensureProfile } from '@/lib/auth/profile';

/**
 * OAuth callback — exchanges the PKCE code for a session.
 *
 * The `Cache-Control: private, no-store` header on every response is not
 * boilerplate. This endpoint's response sets the session cookie; if a CDN or
 * any shared cache stored it, one user's session could be served to another.
 * A cached auth callback is an account-takeover primitive, so the header goes
 * on the failure paths too.
 */

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
} as const;

function redirectTo(request: NextRequest, path: string) {
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = '';
  return NextResponse.redirect(url, { headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const oauthError = request.nextUrl.searchParams.get('error');

  if (oauthError || !code) {
    // The user declined, or the link was malformed. Not an exceptional state.
    return redirectTo(request, '/');
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return redirectTo(request, '/');
  }

  // First sign-in has no profile row yet. Creating it here rather than lazily
  // on first read means every later query can assume it exists.
  await ensureProfile();

  // `next` is attacker-controllable, so only a same-origin path is honoured —
  // otherwise this is an open redirect hanging off the auth flow.
  const requested = request.nextUrl.searchParams.get('next');
  const destination =
    requested && requested.startsWith('/') && !requested.startsWith('//')
      ? requested
      : '/chats';

  return redirectTo(request, destination);
}
