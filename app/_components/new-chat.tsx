'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface Person { id: string; name: string; color: string }
export interface ClearanceOption { id: string; name: string; level: number }

/**
 * Create a chat.
 *
 * All validation lives in `create_chat()` — a DM has exactly two people, a
 * group needs a name, you cannot gate a chat above your own clearance. This
 * form disables what it can and surfaces the database's message for the rest.
 *
 * The clearance list is already filtered to what the viewer holds, so the
 * "above your own clearance" error is mostly unreachable from the UI. It is
 * still enforced server-side, because a form that hides an option has not
 * prevented anything.
 */
export function NewChat({
  people,
  clearances,
}: {
  people: Person[];
  clearances: ClearanceOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'dm' | 'group' | 'agent'>('group');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearanceId, setClearanceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      // A DM is between two people, so choosing someone replaces the choice
      // rather than adding to it.
      else if (type === 'dm') return new Set([id]);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          name: type === 'dm' ? null : name,
          memberIds: type === 'agent' ? [] : [...selected],
          requiredClearanceId: type === 'group' && clearanceId ? clearanceId : null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'could not create chat');
      router.push(`/chat/${body.chatId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not create chat');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="border border-border bg-surface-raised px-3 py-1.5 text-xs transition hover:border-border-strong"
      >
        New chat
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="w-full border border-border bg-surface p-4"
    >
      <div className="mb-4 flex gap-1">
        {(['group', 'dm', 'agent'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setType(t); setSelected(new Set()); }}
            className={` px-3 py-1.5 text-xs transition ${
              type === t ? 'bg-surface-raised text-foreground' : 'text-muted hover:text-foreground'
            }`}
          >
            {t === 'dm' ? 'Direct message' : t === 'agent' ? 'Just me and Quorum' : 'Group'}
          </button>
        ))}
      </div>

      {type !== 'dm' && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={type === 'agent' ? 'Name (optional)' : 'Group name'}
          className="mb-3 w-full border border-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-border-strong"
        />
      )}

      {type === 'group' && clearances.length > 0 && (
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-muted">
            Clearance required (optional). A chat above someone&rsquo;s level is
            invisible to them — not merely locked.
          </span>
          <select
            value={clearanceId}
            onChange={(e) => setClearanceId(e.target.value)}
            className="w-full border border-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-border-strong"
          >
            <option value="">No clearance required</option>
            {clearances.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      )}

      {type !== 'agent' && (
        <div className="mb-3">
          <span className="mb-1 block text-xs text-muted">
            {type === 'dm' ? 'Who with?' : 'Who else?'}
          </span>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {people.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-surface-raised">
                  <input
                    type={type === 'dm' ? 'radio' : 'checkbox'}
                    name="participants"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="accent-[var(--accent)]"
                  />
                  <span
                    className="grid h-5 w-5 place-items-center rounded-full text-[10px] text-background"
                    style={{ background: p.color }}
                  >
                    {p.name.charAt(0).toUpperCase()}
                  </span>
                  {p.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mb-3 text-xs text-danger">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="border border-border bg-surface-raised px-3 py-1.5 text-xs transition hover:border-border-strong disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="px-3 py-1.5 text-xs text-muted transition hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
