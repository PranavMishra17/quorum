import { serverEnv } from '@/config';
import { connectorCryptoAvailable } from './crypto';

/**
 * Google connector — read-only Gmail and Calendar.
 *
 * ---------------------------------------------------------------------------
 * PLAIN `fetch`, NOT `googleapis`
 *
 * `googleapis` is a generated client for ~400 APIs and tens of megabytes; this
 * uses four endpoints. On a serverless function that weight is real, and the
 * generated surface makes it easy to reach an API nobody reviewed — the client
 * does not know which scopes were granted, so a stray call fails at Google
 * rather than at us. Four `fetch` calls are auditable in one screen and the
 * request that goes out is the request you can read here.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND AUTHORISATION, NOT PART OF SIGN-IN
 *
 * Supabase holds the Google credentials used for authentication and does not
 * expose a refresh token carrying extra scopes. That is a constraint, and it
 * happens to be the right shape: reading someone's mail is a separate,
 * explicit grant they make knowingly, rather than something that arrives
 * silently attached to "sign in with Google".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT AVAILABLE
 *
 * No send, no modify, no label management, no draft creation. The scopes below
 * are the entire capability, and both are `.readonly`. An agent that can send
 * mail is an agent an injected document can send mail *with* — and unlike a
 * fetch to an attacker's URL, that one arrives signed by the user.
 */

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary';

/**
 * Where the OAuth CSRF `state` value is parked between the consent redirect and
 * the callback. Named here rather than in either route so the two cannot drift
 * apart — a mismatch would silently disable the check rather than fail loudly.
 */
export const STATE_COOKIE = 'quorum_google_oauth_state';

/** Every request to Google gets its own deadline; none may hang a turn. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * The connector is available only when EVERY part of it is configured —
 * credentials *and* the encryption key. A half-configured connector that
 * accepts a grant and then cannot store the token has taken a user through a
 * mailbox consent screen for nothing.
 */
export function googleConfig(): GoogleOAuthConfig | null {
  const env = serverEnv();
  if (
    !env.GOOGLE_OAUTH_CLIENT_ID ||
    !env.GOOGLE_OAUTH_CLIENT_SECRET ||
    !env.GOOGLE_OAUTH_REDIRECT_URI ||
    !connectorCryptoAvailable()
  ) {
    return null;
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  };
}

export function googleConnectorConfigured(): boolean {
  try {
    return googleConfig() !== null;
  } catch {
    // serverEnv() throws on a client import or an incomplete environment.
    return false;
  }
}

// ---------------------------------------------------------------------------
// The OAuth dance
// ---------------------------------------------------------------------------

/**
 * Build the consent URL.
 *
 * `access_type=offline` with `prompt=consent` is what actually returns a
 * refresh token. Without `prompt=consent`, Google returns one only on the very
 * first grant — so a user who reconnects after disconnecting gets an access
 * token, no refresh token, and a connector that works for an hour and then
 * silently stops. That is a genuinely common bug and worth the extra screen.
 */
export function googleAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface TokenGrant {
  refreshToken: string;
  /** What Google actually granted — a user may untick a scope on the screen. */
  scopes: string[];
}

/** Exchange an authorisation code for a refresh token. */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
): Promise<TokenGrant | null> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await postForm(TOKEN_ENDPOINT, body);
  if (!res) return null;

  const refreshToken = typeof res.refresh_token === 'string' ? res.refresh_token : null;
  if (!refreshToken) {
    // No refresh token means offline access was not granted. Storing the
    // access token instead would produce a connector that works for one hour.
    return null;
  }

  const scopes = typeof res.scope === 'string' ? res.scope.split(' ').filter(Boolean) : [];
  return { refreshToken, scopes };
}

/**
 * Trade a refresh token for a short-lived access token.
 *
 * The access token is never persisted. It lives for the duration of one tool
 * call and is thrown away — one fewer credential at rest, and it means a stale
 * cache can never be the reason a revoked connection keeps working.
 */
export async function accessTokenFor(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<string | null> {
  const res = await postForm(
    TOKEN_ENDPOINT,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    }),
  );
  return res && typeof res.access_token === 'string' ? res.access_token : null;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export interface EmailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  /** Google's own preview text. See below for why bodies are not fetched. */
  snippet: string;
}

/**
 * Search the actor's mailbox.
 *
 * ---------------------------------------------------------------------------
 * HEADERS AND SNIPPETS, NOT FULL BODIES
 *
 * `format=metadata` returns the headers we name plus Google's snippet, and
 * nothing else. Three reasons, in order of weight:
 *
 * 1. **Injection surface.** Email is the most attacker-controllable input in
 *    any product — anyone who knows your address can put text in front of your
 *    agent for free. A snippet is ~200 characters; a body is unbounded prose
 *    with room for a convincing set of instructions. Both are untrusted, and
 *    both are fenced and close the D-022 trapdoor; less of it is still better.
 *
 * 2. **It is enough to answer the question asked.** "Has the contract come
 *    back from Beta GmbH?" is answered by a sender, a subject and a date.
 *
 * 3. **The results reach everyone in the chat.** A mailbox has no audience
 *    snapshot (see docs/EMAIL-SETUP.md), which is why the tool is restricted to
 *    DMs and agent chats — but even there, less exposure is better.
 *
 * A version that reads bodies is a small change here and a much larger one to
 * justify. It should be a decision with a diff, not a default.
 */
export async function searchMessages(
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<EmailSummary[]> {
  const list = await getJson(
    `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    accessToken,
  );
  const ids = Array.isArray(list?.messages)
    ? (list.messages as { id?: string }[]).map((m) => m.id).filter((id): id is string => !!id)
    : [];
  if (ids.length === 0) return [];

  const headers = ['From', 'To', 'Subject', 'Date'];
  const query_ = headers.map((h) => `metadataHeaders=${h}`).join('&');

  const messages = await Promise.all(
    ids.slice(0, maxResults).map((id) =>
      getJson(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&${query_}`, accessToken),
    ),
  );

  return messages.filter(Boolean).map((m) => {
    const raw = (m!.payload as { headers?: { name: string; value: string }[] } | undefined)?.headers ?? [];
    const header = (name: string) =>
      raw.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    return {
      id: String(m!.id ?? ''),
      from: header('From'),
      to: header('To'),
      subject: header('Subject'),
      date: header('Date'),
      snippet: typeof m!.snippet === 'string' ? m!.snippet : '',
    };
  });
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  attendeeCount: number;
}

/**
 * List events on the actor's primary calendar within a window.
 *
 * `singleEvents=true` expands recurring events into their occurrences, which is
 * the only form that can be sorted by start time and the only form that answers
 * "what is on Thursday". Without it a weekly standup is one row with a
 * recurrence rule the model would have to interpret itself.
 *
 * Attendees are counted, not named. The count answers "is this a big meeting";
 * the names are other people's data, reaching a chat none of them are in.
 */
export async function listEvents(
  accessToken: string,
  timeMin: string,
  timeMax: string,
  maxResults: number,
): Promise<CalendarEvent[]> {
  const url =
    `${CALENDAR_BASE}/events?timeMin=${encodeURIComponent(timeMin)}` +
    `&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=${maxResults}`;

  const data = await getJson(url, accessToken);
  const items = Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : [];

  return items.slice(0, maxResults).map((e) => {
    const start = e.start as { dateTime?: string; date?: string } | undefined;
    const end = e.end as { dateTime?: string; date?: string } | undefined;
    return {
      id: String(e.id ?? ''),
      summary: typeof e.summary === 'string' ? e.summary : '(no title)',
      start: start?.dateTime ?? start?.date ?? '',
      end: end?.dateTime ?? end?.date ?? '',
      location: typeof e.location === 'string' ? e.location : '',
      attendeeCount: Array.isArray(e.attendees) ? e.attendees.length : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Google's error bodies quote the request back, and the request contains the
 * user's search query. Nothing from a response body is ever returned to a
 * caller or logged — a failure is a failure, and the shape of it is the most
 * that leaves this module.
 */
async function getJson(
  url: string,
  accessToken: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function postForm(
  url: string,
  body: URLSearchParams,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
