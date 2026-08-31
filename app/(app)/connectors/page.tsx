import Link from 'next/link';
import { createClient, requireActor } from '@/lib/db/server';
import { googleConnectorConfigured, GOOGLE_SCOPES } from '@/lib/connectors/google';
import { untypedDb } from '@/lib/connectors/rpc';
import { Disconnect } from './disconnect';

export const metadata = { title: 'Connectors' };

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

  const { data, error } = await untypedDb(supabase).rpc('connector_status');
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
        <h1 className="text-lg font-semibold">Connectors</h1>
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
      </section>

      <Link href="/chats" className="inline-block text-xs text-foreground underline">
        Back to chats
      </Link>
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
