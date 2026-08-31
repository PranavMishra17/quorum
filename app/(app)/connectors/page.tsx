import Link from 'next/link';
import { createClient, requireActor } from '@/lib/db/server';
import { googleConnectorConfigured, GOOGLE_SCOPES } from '@/lib/connectors/google';
import { Disconnect } from './disconnect';
import { CAPABILITIES, CAPABILITY_GROUPS, type Capability } from '@/lib/agent/catalogue';

export const metadata = { title: 'Capabilities' };

/**
 * Connected external accounts.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE NEVER SEES A TOKEN
 *
 * `connector_tokens` has RLS on and no policy, so the session-bound client
 * below cannot read it at all. The status comes from `connector_status()`, a
 * SECURITY DEFINER function that returns the caller's own rows *without* the
 * token column. There is deliberately no RPC that returns a token to a browser:
 * one would put a mailbox credential a single XSS away from an attacker.
 *
 * The consequence is a page that can say "connected on the 3rd, these scopes"
 * and can never say more, which is exactly as much as a user needs.
 */
export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireActor();
  const { status } = await searchParams;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('connector_status');
  if (error) {
    // Surfaced rather than swallowed. A discarded error here would render as
    // "not connected" — the exact failure that made a user look like a
    // non-member of their own DM earlier in this build.
    console.error('[connectors] status lookup failed', { code: error.code });
  }

  const rows = (data ?? []) as unknown as {
    provider: string;
    scopes: string[];
    connected_at: string;
    revoked_at: string | null;
  }[];

  const google = rows.find((r) => r.provider === 'google' && !r.revoked_at) ?? null;
  const configured = googleConnectorConfigured();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-semibold">Capabilities</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Everything Quorum can do, and what each one costs you. The second
          column is the one worth reading — every capability here takes
          something in exchange, and a page that lists only what a product can
          do is marketing.
        </p>
      </div>

      {(Object.keys(CAPABILITY_GROUPS) as Capability['group'][]).map((key) => {
        const group = CAPABILITY_GROUPS[key];
        const items = CAPABILITIES.filter((c) => c.group === key);
        if (items.length === 0) return null;
        return (
          <section key={key}>
            <h2 className="label text-foreground">{group.title}</h2>
            <p className="mb-3 mt-1 max-w-2xl text-xs leading-relaxed text-muted">{group.blurb}</p>
            <ul className="divide-y divide-border border border-border">
              {items.map((c) => (
                <li key={c.title} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr]">
                  <div>
                    <p className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium">{c.title}</span>
                      {c.tool ? (
                        <span className="font-mono text-[11px] text-muted">{c.tool}</span>
                      ) : (
                        <span className="label text-muted">not a tool</span>
                      )}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{c.what}</p>
                    {c.requires && (
                      <p className="label mt-2" style={{ color: 'var(--c2)' }}>
                        {c.requires}
                      </p>
                    )}
                  </div>
                  <div className="border-l border-border pl-3 sm:pl-4">
                    <p className="label text-muted">What it costs</p>
                    <p className="mt-1 text-xs leading-relaxed">{c.cost}</p>
                    <p className="label mt-3 text-muted">Bounded by</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{c.limit}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <div className="border-t border-border pt-8">
        <h2 className="label text-foreground">Connected accounts</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          External accounts the agent may read <strong>on your behalf, in your
          own turns only</strong>. A connection is stored against your user and
          nobody else&apos;s: the agent cannot read your mail in a chat you are
          not in, or in a turn you did not start.
        </p>
      </div>

      {status && <StatusBanner status={status} />}

      <section className="border border-border p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Google — Gmail and Calendar</h2>
            <p className="mt-1 text-xs text-muted">
              Read-only. The agent can search your mail and list your events. It
              cannot send, reply, change or delete anything.
            </p>
          </div>

          {!configured ? (
            <span className="border border-border px-2 py-1 text-xs text-muted">
              Not configured on this deployment
            </span>
          ) : google ? (
            <Disconnect />
          ) : (
            <a
              href="/api/connectors/google/start"
              className="bg-accent px-3 py-1.5 text-xs font-medium text-background"
            >
              Connect Google
            </a>
          )}
        </div>

        {google && (
          <dl className="mt-4 grid gap-2 border-t border-border pt-4 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted">Connected</dt>
              <dd>{new Date(google.connected_at).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted">Scopes actually granted</dt>
              <dd className="break-all">
                {google.scopes.length
                  ? google.scopes.map((s) => s.split('/').pop()).join(', ')
                  : 'not reported'}
              </dd>
            </div>
          </dl>
        )}

        <div className="mt-4 space-y-2 border-t border-border pt-4 text-xs text-muted">
          <p>
            <strong className="text-foreground">Where it can be used.</strong>{' '}
            Direct messages and agent chats only. A mailbox has one owner and no
            notion of who else is in the room, so a search run in a group would
            put your mail in front of everyone in it. Memory has an audience
            rule for this; an inbox does not — so the capability is withheld
            there rather than guarded by asking the agent to be careful.
          </p>
          <p>
            <strong className="text-foreground">What it costs you.</strong>{' '}
            Anything read from your mail is treated as untrusted: it closes the
            turn to any further outward-facing tool, and nothing learned from it
            can become a durable fact about anyone. Email is the cheapest way in
            the world to put text in front of someone else&apos;s assistant.
          </p>
          <p>
            Requested: {GOOGLE_SCOPES.map((s) => s.split('/').pop()).join(', ')}.
          </p>
        </div>

        {configured && !google && <SetupChecklist />}
      </section>

      <Link href="/chats" className="inline-block text-xs underline underline-offset-4">
        Back to the workspace
      </Link>
    </div>
  );
}

/**
 * What is left to do in GOOGLE'S CONSOLE, not in this codebase.
 *
 * `configured` only means our four environment variables are set — the code
 * path builds a correct consent URL and can decrypt what comes back. It says
 * nothing about whether Google's side will actually complete the exchange:
 * the Gmail and Calendar APIs have to be individually enabled on the project,
 * both scopes have to be added on the OAuth consent screen, this exact
 * redirect URI has to be listed on the OAuth client, and — while the app is
 * unpublished — the signed-in account has to be added as a test user. Every
 * one of those is a `redirect_uri_mismatch` or an `access_denied` with no
 * useful stack trace on our side, because the failure happens on Google's
 * server before any of our code runs.
 *
 * So this is shown between "configured" and "connected": the gap where a
 * developer is currently guessing which Console tab to open. See
 * docs/EMAIL-SETUP.md for the full walkthrough this summarises.
 */
function SetupChecklist() {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="label" style={{ color: 'var(--c2)' }}>
        Before &ldquo;Connect Google&rdquo; will complete
      </p>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
        The environment variables are set, so the button above will start the
        flow — but Google&apos;s side needs its own setup, done once per
        project, in{' '}
        <a
          href="https://console.cloud.google.com/apis/credentials"
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Google Cloud Console
        </a>
        :
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted">
        <li>
          <strong className="text-foreground">APIs &amp; Services → Library</strong> — enable both the
          Gmail API and the Google Calendar API.
        </li>
        <li>
          <strong className="text-foreground">OAuth consent screen → Data access</strong> — add both
          scopes: <code className="font-mono">gmail.readonly</code> and{' '}
          <code className="font-mono">calendar.readonly</code>.
        </li>
        <li>
          <strong className="text-foreground">Credentials → your OAuth client → Authorised redirect URIs</strong> —
          add exactly:
          <code className="mt-1 block break-all border border-border bg-surface-raised px-2 py-1 font-mono">
            http://localhost:3000/api/connectors/google/callback
          </code>
          (and your deployed URL&apos;s equivalent, for production).
        </li>
        <li>
          <strong className="text-foreground">OAuth consent screen → Audience → Test users</strong> — add the
          Google account you intend to connect with. While the app is
          unpublished, only listed accounts can complete the grant.
        </li>
      </ol>
      <p className="mt-2 text-xs text-muted">
        All four are one-time, per Google Cloud project. Full walkthrough:{' '}
        <code className="font-mono">docs/EMAIL-SETUP.md</code>.
      </p>
    </div>
  );
}

function StatusBanner({ status }: { status: string }) {
  const messages: Record<string, { tone: 'ok' | 'warn'; text: string }> = {
    connected: { tone: 'ok', text: 'Google connected.' },
    declined: { tone: 'warn', text: 'You declined at Google. Nothing was connected.' },
    'state-mismatch': {
      tone: 'warn',
      text:
        'That callback did not match the request that started it, so it was refused. ' +
        'Start the connection again from this page.',
    },
    'no-refresh-token': {
      tone: 'warn',
      text:
        'Google did not return offline access, so the connection would have stopped ' +
        'working within the hour. Nothing was stored — try again and accept both scopes.',
    },
    'store-failed': { tone: 'warn', text: 'The grant could not be stored. Nothing was connected.' },
    unavailable: { tone: 'warn', text: 'The Google connector is not configured on this deployment.' },
    disconnected: { tone: 'ok', text: 'Google disconnected.' },
  };

  const message = messages[status];
  if (!message) return null;

  return (
    <p
      className={` border px-3 py-2 text-xs ${
        message.tone === 'ok'
          ? 'border-border text-foreground'
          : 'border-danger/40 text-danger'
      }`}
    >
      {message.text}
    </p>
  );
}
