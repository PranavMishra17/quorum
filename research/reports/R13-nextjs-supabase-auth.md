# R13 — Next.js 16 App Router + Supabase auth

**Band:** B · **Closes:** no D-0xx directly (implementation-fluency track; feeds D-009 evidence) · **Status:** complete

## Question

Quorum is TypeScript end to end on Next.js (Vercel) and Supabase Postgres, and the
architecture (`docs/ARCHITECTURE.md`) splits `lib/db/browser.ts` (anon key, RLS
enforced) from `lib/db/server.ts` (session-bound) from `lib/db/scoped-agent.ts`
(service-role, the agent's only door into the data). None of that is safe to
build against stale knowledge: Next.js 16 shipped mid-2026 with a renamed
middleware convention and fully-async request APIs, and `@supabase/ssr` has
moved its guidance away from patterns that were standard even a year ago
(`getSession()` server-side is now explicitly discouraged). Getting the
auth/session wiring wrong is exactly the kind of thing that "looks like it
works in the demo" — a stale cookie, a middleware-only guard, a realtime
subscription that quietly ignores RLS — while actually reopening the audience
leak the whole project exists to close. This track exists to pin the current,
correct patterns before tier 1 writes any of `lib/db/*`, `app/(app)/*`, or the
chat route handlers.

## Findings

**1. `@supabase/ssr` current patterns.**
The supported shape is two clients: `createBrowserClient()` for Client
Components, `createServerClient()` for Server Components, Server Actions, and
Route Handlers, each built from a small cookie adapter (`getAll`/`setAll`)
rather than the old `get`/`set`/`remove` trio. `auth-helpers-nextjs` is
deprecated in favor of `@supabase/ssr`. The critical, non-obvious change:
Supabase's own docs now say **never trust `getSession()` on the server** —
it does not guarantee revalidation — and instead call `getClaims()`, which
validates the JWT signature against Supabase's published public keys. Session
refresh still requires a proxy/middleware layer, because Server Components
cannot write cookies: the proxy calls `supabase.auth.getClaims()` (which
refreshes an expired token as a side effect), writes the refreshed cookie to
both the incoming request (so downstream Server Components read it fresh)
and the outgoing response (so the browser gets it). Supabase clients must be
constructed **inside the request handler**, not at module scope — a
module-level client leaks session state across concurrent requests on the
same server process.
[Supabase Docs — Setting up Server-Side Auth for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs)
[Supabase Docs — Advanced guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)

**2. Cookie handling in Next 16.**
As of Next.js 16, synchronous access to `cookies()`, `headers()`, and
`draftMode()` is fully removed (Next 15 had it as a deprecated compatibility
shim); all three must be awaited everywhere, including inside the
`@supabase/ssr` cookie adapter passed to `createServerClient()`. Auth routes
(the callback route in particular) must set
`Cache-Control: private, no-store` explicitly, or a CDN/edge cache can serve
one user's session cookie response to another.
[Next.js Docs — Upgrading: Version 16](https://nextjs.org/docs/app/guides/upgrading/version-16)
[Supabase Docs — Advanced guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)

**3. Google OAuth end to end.**
`supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${origin}/auth/callback` } })` from a Client Component starts a PKCE flow: the
client generates a code verifier, sends its hashed challenge to Supabase,
which redirects to Google, and Google redirects back to Supabase, which
redirects to the app's callback URL with a short-lived `code` param (5-minute
validity, single use). A Route Handler at `app/auth/callback/route.ts` reads
`code` from the query string and calls
`supabase.auth.exchangeCodeForSession(code)`, which validates the verifier
and sets the session cookies via the server client's cookie adapter, then
redirects into the app. The redirect URL must be present in Supabase's
allow-list or the exchange fails closed.
[Supabase Docs — Login with Google](https://supabase.com/docs/guides/auth/social-login/auth-google)

**4. Server vs Client Components for the chat surface.**
Nothing in the primary docs states a single canonical boundary for this —
it's a design call, not a spec — but the constraints line up cleanly: the
initial message list and membership/clearance-scoped data should be fetched
in a Server Component via `lib/db/server.ts` (session-bound, RLS-enforced,
zero client-side round trip, no exposure of query shape). The live
subscription itself must run in a Client Component, because
`createBrowserClient()` (and the Realtime `.channel()` API) is a browser-only
construct — there is no supported way to hold an open WebSocket subscription
from a Server Component. The practical pattern is a thin Client Component
("MessageList" or similar) that receives the server-fetched initial rows as
props and then layers a `useEffect`-mounted Realtime subscription on top,
appending new rows to the same list the server already authorized. This
keeps the *first paint* fully RLS-authorized server-side and the *live
updates* authorized by the same RLS policies evaluated per-connection (see
finding 5).

**5. Realtime subscriptions and RLS — do they respect it?**
Yes, but with three findings the assignment implied and the docs confirm,
plus one caveat worth flagging as a genuine finding for this project.
- `postgres_changes` subscriptions are filtered server-side: Realtime sends a
  changed row to a subscribed client only if that client's Postgres role
  could `SELECT` it under RLS. This is automatic once RLS is enabled on the
  table — no extra Realtime-specific policy needed for `postgres_changes`.
- The newer, recommended-for-new-work mechanism is **Realtime Authorization**:
  private channels (`private: true` client-side, "Allow public access" off in
  project settings) are gated by RLS policies written against a dedicated
  `realtime.messages` table, not the underlying data table. Realtime runs a
  rolled-back test query against that table to decide whether a client's JWT
  may subscribe to a given channel topic.
- **Caveat (uncertain / worth flagging, not smoothing over):** Supabase's
  own docs state that RLS policy evaluation for a Realtime connection is
  **cached for the lifetime of that WebSocket connection** and only
  re-evaluated on reconnect or a new JWT. This is directly relevant to D-009
  (authorisation consistency mid-turn): if a member's clearance is revoked or
  they are removed from a chat, an already-open Realtime subscription for
  that browser tab may keep receiving `postgres_changes`/broadcast events
  until it reconnects — the staleness window is not "until the next request"
  but "until the socket drops." I did not find a Supabase-documented upper
  bound on that window (no forced server-side connection eviction on
  membership change is documented), so this should be treated as an open
  risk, not a solved one, until confirmed against Supabase's connection
  lifecycle docs or tested directly.
- RLS is also **not applied to `DELETE`** events on `postgres_changes` — a
  deleted row can't be re-checked against a policy after the fact, so a
  `DELETE` broadcast may reach clients who could not have `SELECT`ed the row.
  This matters for Quorum only if message *deletion* is ever surfaced over
  Realtime; worth a one-line note in `docs/DECISIONS.md` if/when that
  feature is built.
[Supabase Docs — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
[Supabase Docs — Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
[Supabase Blog — Realtime Row Level Security in PostgreSQL](https://supabase.com/blog/realtime-row-level-security-in-postgresql)

**6. Streaming a model response from a route handler.**
Next.js 16 Route Handlers can return a raw `ReadableStream` from the Web
Streams API — no React rendering involved, appropriate for Server-Sent
Events or chunked text. The Anthropic SDK's `client.messages.stream()`
returns an async-iterable stream that can be piped into a
`ReadableStream({ async pull(controller) { ... } })` and returned directly as
the `Response` body with `Content-Type: text/event-stream` (or plain chunked
text). This composes with `lib/llm/provider.ts`'s stated seam: the route
handler talks to `provider.ts`, not to the Anthropic SDK directly, so
swapping providers stays a one-file change per the extensibility charter.
[Next.js Docs — Guides: Streaming](https://nextjs.org/docs/app/guides/streaming)

**7. Optimistic UI on send.**
Standard pattern, not Supabase-specific: insert a locally-tagged optimistic
row (client-generated id) into the rendered list immediately on send, `POST`
to the route handler (or call a Server Action), and reconcile in one of two
ways once the real row lands — either the HTTP response return value swaps
the optimistic row for the persisted one, or the Realtime `postgres_changes`
INSERT event for that row arrives and the client de-dupes by matching a
client-generated idempotency key against the row instead of appending a
duplicate. React 19.2 (bundled with Next.js 16's App Router) ships
`useOptimistic` for exactly this. This is also where D-011's leaning toward a
client-supplied `client_message_id` with a unique constraint on
`(chat_id, client_message_id)` pays off directly: it's the same key used for
optimistic-row reconciliation and for turn idempotency, so it doesn't need to
be invented twice.
[React Docs — 19.2 announcement](https://react.dev/blog/2025/10/01/react-19-2)

**8. Middleware/proxy and route protection.**
Two independent, primary-source findings converge on the same conclusion.
First, Next.js 16 **renamed `middleware.ts` to `proxy.ts`** (and the exported
function `middleware` to `proxy`); `middleware.ts` is deprecated, not
removed outright, but new code should use `proxy.ts` — this is a direct,
load-bearing fact for anything Quorum's README or setup docs say about
"the middleware." Second, and more important for the non-negotiables in
`CLAUDE.md`: **CVE-2025-29927** (CVSS 9.1) showed that Next.js middleware
could be bypassed entirely by a spoofed `x-middleware-subrequest` header on
self-hosted deployments running `next start` with `output: standalone` —
attackers skipped every middleware-enforced check, including auth gates.
Vercel-hosted deployments were automatically protected against that specific
CVE, but the general lesson is the one the codebase's own thesis #2 already
states independently: **membership and clearance must be enforced at the
data layer (RLS), not only at the routing layer.** Middleware/proxy route
protection is correctly a UX-layer redirect (send an unauthenticated user to
`/login` before they see a flash of protected UI) and must never be the sole
authorization boundary — RLS policies on every table (non-negotiable #1) are
what actually stop an unauthorized read even if a proxy check is bypassed,
misconfigured, or simply absent from a route someone forgot to protect.
[Next.js Docs — Upgrading: Version 16, "`middleware` to `proxy`"](https://nextjs.org/docs/app/guides/upgrading/version-16)
[Datadog Security Labs — Understanding CVE-2025-29927](https://securitylabs.datadoghq.com/articles/nextjs-middleware-auth-bypass/)

## Application to Quorum

- **`app/proxy.ts`, not `app/middleware.ts`.** `docs/ARCHITECTURE.md`'s file
  layout and any setup docs (`docs/SETUP-*`) that reference "middleware"
  should use the `proxy.ts` filename and a `proxy()` export, since the repo
  will build against Next 16. If tier 1 code is scaffolded with
  `middleware.ts`, it should be renamed before merge, not left to work
  because the deprecated path still functions — `CLAUDE.md` non-negotiable
  #1 ("RLS on every table... client-side checks exist for UX only") already
  implies the proxy is UX-only; naming it correctly keeps that implicit.
- **`lib/db/server.ts` cookie adapter must be async-aware.** Per finding 2,
  every `cookies()` call inside the `createServerClient()` adapter in
  `lib/db/server.ts` must be `await`ed — this is a hard requirement under
  Next 16, not a style choice, and will fail to build/run otherwise.
- **Use `getClaims()`, not `getSession()`, wherever `lib/db/server.ts` or a
  route handler needs to know who the caller is for an authorization
  decision.** This is the check that feeds `ScopedAgentContext`'s "resolves
  member set + clearance + actor" step (`docs/ARCHITECTURE.md` line ~158) —
  if that resolution ever trusted an unrevalidated `getSession()` read, a
  stale/forged-looking session could pass the two-axis check with a claim
  Supabase itself would reject on `getClaims()`.
- **`app/auth/callback/route.ts`** should be the PKCE exchange endpoint
  (finding 3), returning `Cache-Control: private, no-store`, matching
  `app/(marketing)` → `app/(app)` in the layout table in
  `docs/ARCHITECTURE.md`.
- **Chat surface component split** (finding 4): initial render in a Server
  Component reading through `lib/db/server.ts`; a Client Component owns the
  `createBrowserClient()` Realtime subscription and receives the initial
  rows as props. This directly follows the repo's own stated split between
  `lib/db/browser.ts` (anon, RLS enforced) and `lib/db/server.ts`
  (session-bound) — Realtime necessarily rides on the browser client, since
  there's no server-side subscription API.
- **D-009 gets new, concrete evidence from finding 5's caveat.** The
  Realtime RLS-cache-per-connection behavior is a specific mechanism for the
  "membership changes mid-turn" question R2/D-009 is chartered to answer —
  it is not the same problem as agent-turn TOCTOU (that's a single request;
  this is a long-lived socket), but it's the same *family* of staleness and
  should be cited in `docs/DECISIONS.md` under D-009 as an additional
  surface to resolve, not folded silently into R2's existing scope.
- **`client_message_id`** (finding 7) — the optimistic-UI reconciliation key
  and D-011's idempotency key should be the literal same column/value,
  avoiding a second ID scheme in the messages table.
- **`lib/llm/provider.ts` streaming contract** (finding 6): the route
  handler that streams chat responses should call `provider.ts`'s stream
  method and forward its `ReadableStream` directly to the `Response`,
  keeping the Anthropic SDK's `messages.stream()` call fully behind that one
  file per the extensibility charter row `lib/llm/provider.ts | model,
  provider, or fallback | one file`.

## Recommendation

This track doesn't close an open D-0xx by itself — it's implementation
fluency, not a design fork — but it directly informs **D-009** (mid-turn
authorization consistency). The concrete recommendation for D-009, based on
finding 5, is: **treat Realtime subscriptions as a separate staleness
surface from the agent-turn TOCTOU problem**, and don't let R2's answer for
"the agent turn" implicitly also cover "an open browser tab's live feed."
The two need separate, explicitly stated answers in `docs/DECISIONS.md`.

**Strongest argument against that separation:** it adds scope. R2 was
chartered to close D-009 with one answer; treating Realtime staleness as a
second surface means D-009 doesn't fully close until both are answered, which
risks the decision log accumulating open sub-items instead of a clean
resolution — exactly the kind of scope creep a legal-adjacent take-home
should avoid introducing under time pressure. The counter-argument for
merging them anyway: a single stated policy ("authorization is re-evaluated
at most every N seconds / on every reconnect, and the client is expected to
drop and rebuild the subscription when its own membership might have
changed") could cover both cases with one rule, at the cost of being coarser
than a TOCTOU-specific answer would be for the synchronous agent-turn case.

**What would settle it:** either (a) direct testing against a live Supabase
project — open a Realtime subscription, revoke membership via a second
client, and measure how long events keep arriving before the socket is
forced to reconnect or the app-level unsubscribe fires — or (b) a
Supabase-documented SLA on RLS policy re-evaluation latency for long-lived
connections, which I did not find in the docs consulted for this report.

## Sources

- [Supabase Docs — Setting up Server-Side Auth for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs)
- [Supabase Docs — Advanced guide (server-side auth)](https://supabase.com/docs/guides/auth/server-side/advanced-guide)
- [Supabase Docs — Login with Google](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase Docs — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Supabase Docs — Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase Blog — Realtime Row Level Security in PostgreSQL](https://supabase.com/blog/realtime-row-level-security-in-postgresql)
- [Next.js Docs — Upgrading: Version 16](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Next.js Docs — Guides: Streaming](https://nextjs.org/docs/app/guides/streaming)
- [Datadog Security Labs — Understanding CVE-2025-29927: The Next.js Middleware Authorization Bypass Vulnerability](https://securitylabs.datadoghq.com/articles/nextjs-middleware-auth-bypass/)
- [React Docs — React 19.2 announcement](https://react.dev/blog/2025/10/01/react-19-2)
