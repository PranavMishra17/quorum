import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session refresh and redirects. **THIS IS NOT A SECURITY BOUNDARY.**
 *
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`, and the rename is useful
 * here — it makes the file's job harder to misread. Next's own documentation
 * says it "should not be used as a full session management or authorization
 * solution". This project agrees, for a sharper reason: CVE-2025-29927 (CVSS
 * 9.1) let a spoofed `x-middleware-subrequest` header skip every middleware
 * check. Anything whose only guard runs here is one header away from being
 * ungated.
 *
 * So this file does exactly two things, both of them user experience:
 *
 *   1. Refreshes the Supabase session cookie so it does not expire mid-visit.
 *   2. Redirects a signed-out visitor away from app routes, so they get the
 *      landing page instead of an empty screen.
 *
 * The actual guard is row-level security. If this file were deleted, a
 * signed-out user would reach the chat UI and see **nothing**, because the
 * database would return nothing. That is the test of whether an authorisation
 * story is real: delete the convenience layer and check that the data still
 * refuses to come out.
 */

/** Routes that render the authenticated app. Redirect target, not a guard. */
const APP_PREFIXES = ['/chats', '/chat', '/space'];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getClaims(), not getSession(): the latter does not revalidate, and Supabase
  // says not to trust it server-side. Calling it here also performs the token
  // refresh, which is the main reason this file exists.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const path = request.nextUrl.pathname;
  const isAppRoute = APP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  if (!signedIn && isAppRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Skip static assets and images — running a session refresh for every icon
  // is pure latency.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
