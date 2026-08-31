'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface Rung { id: string; key?: string; name: string; level: number }
export interface DirectoryPerson {
  id: string;
  name: string;
  color: string;
  clearances: Rung[];
}

/**
 * Grant and revoke clearances.
 *
 * The rungs offered are filtered to what the viewer holds. That is UX: the
 * database refuses anything above the caller's own level regardless, and the
 * tests prove it. Showing a button that would always fail is worse than hiding
 * it, but hiding it prevents nothing.
 */
export function ClearanceControls({
  people,
  rungs,
  meId,
  myTopLevel,
}: {
  people: DirectoryPerson[];
  rungs: Rung[];
  meId: string;
  myTopLevel: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const grantable = rungs.filter((r) => r.level <= myTopLevel);

  async function act(action: 'grant' | 'revoke', userId: string, clearanceId: string) {
    const key = `${userId}:${clearanceId}`;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch('/api/clearances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, userId, clearanceId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'not permitted');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'not permitted');
    } finally {
      setBusy(null);
    }
  }

  const shown = filter
    ? people.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : people;

  return (
    <div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Filter ${people.length} people`}
        className="mb-3 w-full max-w-sm border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-border-strong"
      />

      {error && <p className="mb-3 text-xs text-danger">{error}</p>}

      {grantable.length === 0 && (
        <p className="mb-3 border border-dashed border-border p-3 text-xs text-muted">
          You hold no clearance, so you cannot grant one. Someone who holds a
          rung has to grant it to you first — which is the rule that keeps the
          axis meaningful.
        </p>
      )}

      <ul className="space-y-1">
        {shown.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-border bg-surface px-3 py-2"
          >
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] text-background"
              style={{ background: p.color }}
            >
              {p.name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {p.name}
              {p.id === meId && <span className="text-muted"> (you)</span>}
            </span>

            <span className="flex flex-wrap items-center gap-1">
              {rungs.map((r) => {
                const held = p.clearances.some((c) => c.id === r.id);
                const canChange =
                  r.level <= myTopLevel || (p.id === meId && held);
                const key = `${p.id}:${r.id}`;

                if (!held && !canChange) return null;

                return (
                  <button
                    key={r.id}
                    disabled={!canChange || busy === key}
                    onClick={() => act(held ? 'revoke' : 'grant', p.id, r.id)}
                    title={
                      canChange
                        ? held ? `Revoke ${r.name}` : `Grant ${r.name}`
                        : `${r.name} is above your own clearance`
                    }
                    className={` px-2 py-0.5 text-[10px] uppercase tracking-wide transition ${
                      held
                        ? 'bg-surface-raised text-foreground hover:line-through'
                        : 'border border-dashed border-border text-muted hover:border-border-strong hover:text-foreground'
                    } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:no-underline`}
                  >
                    {r.name}
                  </button>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
