'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClearanceStamp } from './clearance';

export interface AdminRung {
  id: string;
  key: string;
  name: string;
  level: number;
  held: boolean;
}

export interface AdminGroup {
  id: string;
  name: string;
  member: boolean;
}

/**
 * The admin-mode buttons.
 *
 * They hold no privilege: each posts to `/api/admin`, which is the only place
 * the arming secret exists. If this component were somehow rendered in
 * production the buttons would 404, and if the route were somehow reachable the
 * database would still refuse — see migration 0016.
 *
 * Both directions are offered for each thing, and the revoke half is the one
 * worth having. "Watch this room disappear when I drop the clearance" is a
 * sharper demonstration of the rule than watching one appear, because a room
 * appearing could be explained by a dozen things and a room vanishing on cue
 * cannot.
 */
export function AdminControls({ rungs, groups }: { rungs: AdminRung[]; groups: AdminGroup[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: 'grant' | 'revoke' | 'join' | 'leave', targetId: string) {
    setBusy(targetId);
    setError(null);
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, targetId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? 'that did not work');
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {error && (
        <p className="border px-3 py-2 text-xs" style={{ borderColor: 'var(--c3)', color: 'var(--c3)' }}>
          {error}
        </p>
      )}

      <section>
        <h2 className="label mb-3 text-foreground">Clearance</h2>
        <ul className="divide-y divide-border border border-border">
          {rungs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <ClearanceStamp level={r.level} name={r.name} />
              <span className="text-xs text-muted">{r.held ? 'Held' : 'Not held'}</span>
              <button
                onClick={() => act(r.held ? 'revoke' : 'grant', r.id)}
                disabled={busy === r.id}
                className="label ml-auto border border-border-strong px-3 py-1.5 transition hover:bg-surface-raised disabled:opacity-50"
              >
                {busy === r.id ? '…' : r.held ? 'Revoke' : 'Grant to me'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="label mb-1 text-foreground">Groups you can see</h2>
        <p className="mb-3 max-w-2xl text-xs leading-relaxed text-muted">
          Only groups the rules already let you see are listed. Admin mode raises
          what you hold; it does not hand you a directory of rooms currently
          hidden from you. To reach one of those, grant yourself its clearance
          first and watch it appear here.
        </p>
        {groups.length === 0 ? (
          <p className="border border-dashed border-border p-6 text-xs text-muted">
            No groups visible at your current clearance.
          </p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {groups.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 truncate text-sm">{g.name}</span>
                <span className="label text-muted">{g.member ? 'Member' : 'Not a member'}</span>
                <button
                  onClick={() => act(g.member ? 'leave' : 'join', g.id)}
                  disabled={busy === g.id}
                  className="label border border-border-strong px-3 py-1.5 transition hover:bg-surface-raised disabled:opacity-50"
                >
                  {busy === g.id ? '…' : g.member ? 'Leave' : 'Join'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
