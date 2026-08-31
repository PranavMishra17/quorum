'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClearanceStamp } from './clearance';

export interface Person { id: string; name: string; color: string }
export interface ClearanceOption { id: string; name: string; level: number }

/**
 * Create a group.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONLY MAKES GROUPS NOW
 *
 * It used to offer three chat types in one flat form — group, DM, and a solo
 * agent chat — which meant the first decision a user faced was "which of three
 * things am I making", for two of which a purpose-built affordance already
 * exists elsewhere: clicking a person opens a DM (`/api/dm`), and the Q tile on
 * the workspace home opens the agent. Keeping those choices IN this form as
 * well was the reported complaint — "not intuitive enough" — and the fix is
 * fewer decisions, not a better-labelled dropdown.
 *
 * A second private chat with the agent is still reachable — from the Q tile's
 * own affordances, not from here — because it is a real but rare need and does
 * not deserve a permanent slot beside the common case.
 *
 * ---------------------------------------------------------------------------
 * WHY CLEARANCE IS STAMPS, NOT A <select>
 *
 * Everywhere else in the product, a clearance is a coloured stamp — the one
 * visual grammar the whole redesign is built on. A bare dropdown here broke
 * that grammar at the exact moment a user is making the decision that MATTERS
 * most: what this room requires. Now picking a level is the same gesture as
 * reading one everywhere else.
 *
 * All validation still lives in `create_chat()` — a group needs a name, you
 * cannot gate above your own clearance. This form disables what it can and
 * surfaces the database's message for the rest; hiding an option in the UI has
 * never been the thing that prevents it.
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
  const [name, setName] = useState('');
  const [clearanceId, setClearanceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredPeople = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
  }, [people, filter]);

  const chosen = useMemo(
    () => people.filter((p) => selected.has(p.id)),
    [people, selected],
  );

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
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
          type: 'group',
          name,
          memberIds: [...selected],
          requiredClearanceId: clearanceId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'could not create the group');
      router.push(`/people?open=${body.chatId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not create the group');
      setBusy(false);
    }
  }

  function reset() {
    setOpen(false);
    setError(null);
    setName('');
    setClearanceId(null);
    setSelected(new Set());
    setFilter('');
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="border border-border bg-surface-raised px-3 py-1.5 text-xs transition hover:border-border-strong"
      >
        New group
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-md border border-border-strong bg-surface p-4"
    >
      <p className="label mb-3 text-foreground">New group</p>

      <label className="mb-4 block">
        <span className="label mb-1 block text-muted">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Contract Review"
          autoFocus
          className="w-full border border-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-border-strong"
        />
      </label>

      <div className="mb-4">
        <span className="label mb-1.5 block text-muted">
          Who can see it
        </span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setClearanceId(null)}
            className={`label border px-2 py-1.5 transition ${
              clearanceId === null
                ? 'border-foreground text-foreground'
                : 'border-border text-muted hover:border-border-strong'
            }`}
          >
            No requirement
          </button>
          {clearances.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setClearanceId(c.id)}
              className={`transition ${clearanceId === c.id ? '' : 'opacity-50 hover:opacity-100'}`}
            >
              <ClearanceStamp level={c.level} name={c.name} />
            </button>
          ))}
        </div>
        {clearanceId && (
          <p className="mt-1.5 text-[11px] leading-snug text-muted">
            Invisible to anyone who does not hold this — not merely locked.
          </p>
        )}
      </div>

      <div className="mb-4">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="label text-muted">Add people</span>
          {chosen.length > 0 && <span className="label text-muted">{chosen.length} selected</span>}
        </div>

        {/* Selected people stay visible as chips above the list, so choosing
            someone and then scrolling past them does not feel like losing
            them — the thing a plain checklist over 50+ names cannot show. */}
        {chosen.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {chosen.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                title={`Remove ${p.name}`}
                className="flex items-center gap-1 border border-border-strong bg-surface-raised px-1.5 py-0.5 text-xs transition hover:opacity-70"
              >
                <span
                  className="grid h-3.5 w-3.5 place-items-center rounded-full text-[8px]"
                  style={{ background: p.color, color: 'var(--on-paper)' }}
                  aria-hidden
                >
                  {p.name.charAt(0).toUpperCase()}
                </span>
                {p.name.split(' ')[0]}
                <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search people"
          className="mb-1.5 w-full border border-border bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-border-strong"
        />
        <ul className="max-h-40 space-y-0.5 overflow-y-auto border border-border">
          {filteredPeople.length === 0 && (
            <li className="px-2 py-3 text-center text-xs text-muted">Nobody matches.</li>
          )}
          {filteredPeople.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-surface-raised">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="accent-[var(--paper)]"
                />
                <span
                  className="grid h-5 w-5 place-items-center rounded-full text-[10px]"
                  style={{ background: p.color, color: 'var(--on-paper)' }}
                >
                  {p.name.charAt(0).toUpperCase()}
                </span>
                {p.name}
              </label>
            </li>
          ))}
        </ul>
      </div>

      {error && <p className="mb-3 text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="border border-border-strong bg-surface-raised px-3 py-1.5 text-xs transition hover:bg-surface disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create group'}
        </button>
        <button type="button" onClick={reset} className="px-3 py-1.5 text-xs text-muted transition hover:text-foreground">
          Cancel
        </button>
      </div>
    </form>
  );
}
