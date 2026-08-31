'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * "Reset demo" — deletes the caller's own demo rooms and rebuilds them.
 *
 * The route this calls (`POST /api/demo/reset`) can only ever touch chats
 * where `is_demo = true` AND the caller is a member — see migration 0020's
 * `reset_demo_world()`, which takes no id at all. There is nothing this button
 * could be tricked into deleting beyond the two rooms it made in the first
 * place.
 */
export function ResetDemo() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/demo/reset', { method: 'POST' });
      if (!res.ok) throw new Error();
      router.push('/people');
      router.refresh();
    } catch {
      setError('could not reset the demo world');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={reset}
        disabled={busy}
        className="label border border-border-strong px-3 py-1.5 transition hover:bg-surface-raised disabled:opacity-50"
      >
        {busy ? 'Resetting…' : 'Reset demo'}
      </button>
      {error && <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
      <p className="mt-1 max-w-md text-[11px] leading-snug text-muted">
        Deletes and rebuilds your two demo rooms — the contract review and the
        team sync — from scratch. Nothing else is touched.
      </p>
    </div>
  );
}
