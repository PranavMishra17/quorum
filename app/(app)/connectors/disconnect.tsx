'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/db/browser';
import { untypedRpc } from '@/lib/connectors/rpc';

/**
 * Disconnect the Google connector.
 *
 * Calls `disconnect_connector()` from the browser, which is safe precisely
 * because of that function's signature: it takes a provider and no user id, and
 * scopes itself to `auth.uid()` inside a SECURITY DEFINER body. There is no
 * argument a caller could supply that would revoke someone else's connection.
 *
 * The revocation is soft — the row keeps its history, and the token is refused
 * on every read while `revoked_at` is set. That is a deliberate trade: hard
 * deletion would make "when did Alice disconnect Gmail?" unanswerable, and this
 * is the kind of action an audit trail exists for.
 *
 * WHAT THIS DOES NOT DO: it does not revoke the grant AT GOOGLE. Google still
 * lists Quorum among the user's connected apps until they remove it there. The
 * copy says so rather than implying a completeness this cannot deliver.
 */
export function Disconnect() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);

  function disconnect() {
    start(async () => {
      setFailed(false);
      const supabase = createClient();
      const { error } = await untypedRpc(supabase).rpc('disconnect_connector', {
        p_provider: 'google',
      });
      if (error) {
        setFailed(true);
        return;
      }
      router.push('/connectors?status=disconnected');
      router.refresh();
    });
  }

  return (
    <div className="text-right">
      <button
        onClick={disconnect}
        disabled={pending}
        className="rounded border border-danger/40 px-3 py-1.5 text-xs text-danger disabled:opacity-50"
      >
        {pending ? 'Disconnecting…' : 'Disconnect'}
      </button>
      {failed && <p className="mt-1 text-xs text-danger">Could not disconnect.</p>}
      <p className="mt-1 max-w-[16rem] text-[11px] leading-snug text-muted">
        Revokes it here. To remove Quorum&apos;s access at Google as well, use
        your Google account&apos;s third-party apps settings.
      </p>
    </div>
  );
}
