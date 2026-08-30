import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireActor, NotAuthenticatedError } from '@/lib/db/server';
import { googleAuthUrl, googleConfig, STATE_COOKIE } from '@/lib/connectors/google';

/**
 * Begin the Google connector grant.
 *
 * ---------------------------------------------------------------------------
 * THE `state` PARAMETER IS A CSRF DEFENCE, NOT A FORMALITY
 *
 * Without it, an attacker can complete the OAuth dance in their own browser,
 * stop before the redirect, and then trick a signed-in victim into loading the
 * callback URL with the attacker's code. The victim's account ends up
 * connected to the ATTACKER's mailbox — which sounds harmless until you notice
 * the agent will then quote that mailbox's contents to the victim as their own
 * mail, and act on whatever it says.
 *
 * So: a random value goes into an httpOnly cookie and into the URL, and the
 * callback refuses unless the two match. `sameSite: 'lax'` because the cookie
 * must survive a top-level redirect back from Google; it is not sent on
 * cross-site subrequests, which is the case that matters.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' } as const;

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
  if (!config) {
    // Deliberately not a redirect into Google's error page: this is our
    // configuration missing, not the user's grant failing.
    return NextResponse.json(
      { error: 'the Google connector is not configured on this deployment' },
      { status: 501, headers: NO_STORE },
    );
  }

  const state = randomBytes(32).toString('base64url');
  const response = NextResponse.redirect(googleAuthUrl(config, state), { headers: NO_STORE });

  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: '/api/connectors/google',
    maxAge: 600, // ten minutes is plenty for a consent screen
  });

  return response;
}
