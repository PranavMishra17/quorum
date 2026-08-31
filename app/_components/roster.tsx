'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface RosterMember {
  userId: string;
  name: string;
  color: string;
  role: 'admin' | 'member';
  status: 'member' | 'requested' | 'invited' | 'removed';
}

/**
 * The chat roster, with admin actions.
 *
 * Every button here is UX. The buttons a non-admin should not see are hidden,
 * but hiding is not preventing — the policies in migration 0003 are what refuse
 * the write, and `tests/authorization/membership.test.ts` proves a non-admin
 * cannot add, remove, or promote regardless of what the UI offers.
 *
 * Pending join requests are shown to admins because a request nobody can see is
 * a request nobody will approve.
 */
export function Roster({
  chatId,
  meId,
  members,
  amAdmin,
  chatType,
}: {
  chatId: string;
  meId: string;
  members: RosterMember[];
  amAdmin: boolean;
  chatType: 'dm' | 'group' | 'agent';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: string, userId?: string) {
    setBusy(userId ?? action);
    setError(null);
    try {
      const res = await fetch(`/api/chats/${chatId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, userId }),
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

  const active = members.filter((m) => m.status === 'member');
  const pending = members.filter((m) => m.status === 'requested');

  // A DM has no administration (D-002), and an agent chat has one human.
  const administered = chatType === 'group';

  return (
    <aside className="border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-medium">
        In this chat
        <span className="ml-2 font-normal text-muted">{active.length}</span>
      </h2>

      <ul className="space-y-1.5">
        {active.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 text-sm">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] text-background"
              style={{ background: m.color }}
            >
              {m.name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {m.name}
              {m.userId === meId && <span className="text-muted"> (you)</span>}
            </span>
            {m.role === 'admin' && administered && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                admin
              </span>
            )}
            {amAdmin && administered && m.userId !== meId && (
              <span className="flex shrink-0 gap-1">
                {m.role === 'member' && (
                  <button
                    onClick={() => act('promote', m.userId)}
                    disabled={busy === m.userId}
                    className="text-[10px] text-muted transition hover:text-foreground disabled:opacity-50"
                  >
                    promote
                  </button>
                )}
                <button
                  onClick={() => act('remove', m.userId)}
                  disabled={busy === m.userId}
                  className="text-[10px] text-muted transition hover:text-danger disabled:opacity-50"
                >
                  remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {amAdmin && pending.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-2 text-xs text-muted">Asked to join</h3>
          <ul className="space-y-1.5">
            {pending.map((m) => (
              <li key={m.userId} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-muted">{m.name}</span>
                <button
                  onClick={() => act('approve', m.userId)}
                  disabled={busy === m.userId}
                  className="shrink-0 text-[10px] text-foreground transition hover:underline disabled:opacity-50"
                >
                  approve
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      {administered && (
        <button
          onClick={() => act('leave')}
          disabled={busy === 'leave'}
          className="mt-4 text-xs text-muted transition hover:text-danger disabled:opacity-50"
        >
          {busy === 'leave' ? 'Leaving…' : 'Leave this chat'}
        </button>
      )}
    </aside>
  );
}
