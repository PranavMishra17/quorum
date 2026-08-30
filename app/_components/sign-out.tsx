'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/db/browser';

export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      onClick={async () => {
        setBusy(true);
        await createClient().auth.signOut();
        // refresh() so the server layout re-evaluates the session rather than
        // rendering a stale authenticated shell from the client cache.
        router.replace('/');
        router.refresh();
      }}
      disabled={busy}
      className="text-xs text-muted transition hover:text-foreground disabled:opacity-50"
    >
      {busy ? '…' : 'Sign out'}
    </button>
  );
}
