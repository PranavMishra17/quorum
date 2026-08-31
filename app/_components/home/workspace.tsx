'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClearanceStamp, Redacted, RedactedLines, clearanceToken } from '../clearance';
import { DemoStamp } from '../demo-stamp';
import { useFloatingPanels } from '../floating-panels/context';

export interface DirectoryPerson {
  id: string;
  name: string;
  color: string;
  /** Highest rung held, or null. */
  clearance: { name: string; level: number } | null;
  /** An existing DM, if one is already open. */
  dmChatId: string | null;
}

export interface GroupTile {
  id: string;
  name: string;
  clearance: { name: string; level: number } | null;
  /** Member display names. EMPTY for a group the viewer is not in — the server
   *  does not send them, which is what makes the redaction honest. */
  memberNames: string[];
  memberCount: number | null;
  status: 'member' | 'requested' | 'discoverable';
  role: 'admin' | 'member' | null;
  isDemo: boolean;
}

/**
 * The workspace home.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING IS ONE GRID
 *
 * People and the agent share a grid, and Q is a tile inside it rather than a
 * separate panel above it. That is the product's actual claim made structural:
 * the agent is present in the workspace on the same footing as everyone else,
 * and the only thing distinguishing it is that it is drawn in ink. A separate
 * "Ask the AI" hero would say the opposite — that the agent is a feature bolted
 * onto a chat app.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT REDACTED
 *
 * A group above the viewer's clearance is not here at all. It is not greyed
 * out, not shown locked, not counted in a "3 hidden" line — the existence of a
 * restricted room is itself disclosure (D-027), and a count would leak exactly
 * the fact the rule protects.
 *
 * What IS drawn is a group the viewer is cleared for but not a member of. Its
 * name shows, because that is what makes a join request possible at all, and
 * everything else — who is in it, what was said — is a redaction bar with
 * nothing behind it. That tile is the authorisation model in one object: you
 * may know it exists, and nothing more.
 */
export function Workspace({
  people,
  groups,
  agentChatId,
  newChat,
}: {
  people: DirectoryPerson[];
  groups: GroupTile[];
  /** The viewer's own solo chat with the agent, created on demand if absent. */
  agentChatId: string | null;
  /**
   * The "New chat" control, passed in rather than built here.
   *
   * It needs server-fetched data (the roster, and only the clearances the
   * viewer actually holds), and this is a client component. Slotting it in
   * keeps that query on the server where it belongs, and puts the control in
   * the toggle bar — creating a group used to mean scrolling past 55 people to
   * find it.
   */
  newChat?: React.ReactNode;
}) {
  const router = useRouter();
  const { open } = useFloatingPanels();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'people' | 'groups'>('people');
  const [expanded, setExpanded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => p.name.toLowerCase().includes(q));
  }, [people, query]);

  const openAgent = useCallback(async () => {
    if (agentChatId) {
      open(agentChatId, 'Q');
      return;
    }
    // No solo chat yet — make one, once.
    setBusy('agent');
    try {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'agent', name: 'Q', memberIds: [] }),
      });
      const json = await res.json();
      if (res.ok && json.chatId) {
        open(json.chatId, 'Q');
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [agentChatId, open, router]);

  const openPerson = useCallback(
    async (person: DirectoryPerson) => {
      if (person.dmChatId) {
        open(person.dmChatId, person.name);
        return;
      }
      setBusy(person.id);
      try {
        const res = await fetch('/api/dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: person.id }),
        });
        const json = await res.json();
        if (res.ok && json.chatId) {
          open(json.chatId, person.name);
          router.refresh();
        }
      } finally {
        setBusy(null);
      }
    },
    [open, router],
  );

  /**
   * `q` opens the agent, `/` focuses search.
   *
   * Guarded on the event target rather than on a modal flag: a global handler
   * that steals `q` while someone is typing a message is the classic version of
   * this feature, and it is infuriating. Declared after the callbacks it uses
   * so the listener always closes over the current ones rather than the first
   * render's.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'q') {
        e.preventDefault();
        void openAgent();
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openAgent]);

  /**
   * Four rows, then a door.
   *
   * At 55 people the grid ran to five screens and buried the Groups section
   * under it, so creating a group meant scrolling past everyone in the company.
   * Four rows is enough to read the directory as a directory; the rest is one
   * click away, and searching bypasses the cap entirely because a search result
   * you have to expand to see is not a search result.
   */
  const searching = query.trim() !== '';
  const perRow = 5;
  const qTileCost = searching ? 0 : 2; // Q occupies two cells in the first row
  const visibleCap = perRow * VISIBLE_ROWS - qTileCost;
  const shown = searching || expanded ? filtered : filtered.slice(0, visibleCap);
  const hiddenCount = filtered.length - shown.length;

  return (
    <div className="space-y-8">
      <Search value={query} onChange={setQuery} inputRef={searchRef} count={filtered.length} />

      {/* One toggle instead of a long scroll. Both counts are always visible,
          so the tab you are not on still tells you what is there. */}
      <div className="flex items-center gap-px border-b border-border">
        <Tab active={tab === 'people'} onClick={() => setTab('people')}>
          Directory <span className="ml-1.5 opacity-60">{people.length}</span>
        </Tab>
        <Tab active={tab === 'groups'} onClick={() => setTab('groups')}>
          Groups <span className="ml-1.5 opacity-60">{groups.length}</span>
        </Tab>
        <span className="ml-auto pb-2">{newChat}</span>
      </div>

      {tab === 'people' ? (
        <section>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {!searching && (
              <button
                onClick={() => void openAgent()}
                disabled={busy === 'agent'}
                className="col-span-2 flex min-h-[7.5rem] flex-col justify-between p-4 text-left transition"
                style={{ background: 'var(--ink)', color: 'var(--on-ink)' }}
              >
                <span className="flex items-start justify-between">
                  <span className="font-display text-5xl font-bold leading-none">Q</span>
                  <kbd
                    className="label border px-1.5 py-1 opacity-50"
                    style={{ borderColor: 'currentColor' }}
                  >
                    Q
                  </kbd>
                </span>
                <span className="text-xs leading-snug opacity-70">
                  {busy === 'agent'
                    ? 'Opening…'
                    : 'The agent, alone. It is in every other chat too, and decides for itself whether to speak.'}
                </span>
              </button>
            )}

            {shown.map((p) => (
              <PersonTile
                key={p.id}
                person={p}
                busy={busy === p.id}
                onOpen={() => void openPerson(p)}
              />
            ))}

            {hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(true)}
                className="flex min-h-[7.5rem] flex-col items-center justify-center gap-1 border border-dashed border-border-strong text-center transition hover:bg-surface-raised"
              >
                <span className="font-display text-2xl font-semibold">+{hiddenCount}</span>
                <span className="label text-muted">Show all</span>
              </button>
            )}

            {filtered.length === 0 && (
              <p className="col-span-full py-8 text-center text-sm text-muted">
                Nobody matches “{query}”.
              </p>
            )}
          </div>

          {expanded && !searching && (
            <button
              onClick={() => setExpanded(false)}
              className="label mt-3 text-muted transition hover:text-foreground"
            >
              Show fewer
            </button>
          )}
        </section>
      ) : (
        <section>
          {groups.length === 0 ? (
            <p className="border border-dashed border-border p-8 text-center text-sm text-muted">
              No groups you can see. Create one, or ask for the clearance that
              would make one visible.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => (
                <GroupCard key={g.id} group={g} onOpen={() => open(g.id, g.name)} />
              ))}
            </div>
          )}
          <p className="mt-3 max-w-2xl text-xs leading-relaxed text-muted">
            Groups above your clearance are not listed, greyed out, or counted.
            The existence of a restricted room is itself disclosure, so there is
            nothing here to infer one from.
          </p>
        </section>
      )}
    </div>
  );
}

/** Rows of people shown before the grid folds behind "Show all". */
const VISIBLE_ROWS = 4;

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`label border-b-2 px-4 pb-2 pt-1 transition ${
        active
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function Search({
  value,
  onChange,
  inputRef,
  count,
}: {
  value: string;
  onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  count: number;
}) {
  return (
    <div className="mx-auto max-w-2xl pt-4">
      <div className="flex items-center gap-3 border-b-2 border-border-strong pb-2 focus-within:border-foreground">
        <span aria-hidden className="text-lg text-muted">
          ⌕
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search people"
          aria-label="Search people"
          className="w-full bg-transparent font-display text-2xl outline-none placeholder:text-muted"
        />
        {value ? (
          <span className="label shrink-0 text-muted">{count}</span>
        ) : (
          <kbd className="label shrink-0 border border-border px-1.5 py-1 text-muted">/</kbd>
        )}
      </div>
    </div>
  );
}

function PersonTile({
  person,
  busy,
  onOpen,
}: {
  person: DirectoryPerson;
  busy: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      disabled={busy}
      title={`Message ${person.name}`}
      className="flex min-h-[7.5rem] flex-col justify-between border border-border bg-surface p-3 text-left transition hover:border-border-strong hover:bg-surface-raised disabled:opacity-60"
    >
      <span className="flex items-start justify-between gap-2">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center text-sm font-semibold"
          style={{ background: person.color, color: 'var(--on-paper)' }}
          aria-hidden
        >
          {person.name.charAt(0).toUpperCase()}
        </span>
        {person.clearance ? (
          <ClearanceStamp level={person.clearance.level} />
        ) : (
          <span className="label text-muted">NONE</span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{person.name}</span>
        <span className="label mt-1 block text-muted">
          {busy ? 'Opening…' : person.dmChatId ? 'Open' : 'Message'}
        </span>
      </span>
    </button>
  );
}

/**
 * A group tile.
 *
 * The member row is where the two states diverge, and it is the whole design:
 * a group you are in lists its people, and a group you are only cleared to SEE
 * shows redaction bars. Same tile, same size, same position in the grid —
 * because the difference is not that one is less important, it is that one is
 * withheld.
 */
function GroupCard({ group, onOpen }: { group: GroupTile; onOpen: () => void }) {
  const isMember = group.status === 'member';
  const accent = group.clearance ? clearanceToken(group.clearance.level) : 'var(--c0)';

  const inner = (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="block truncate font-display text-base font-semibold leading-tight">
              {group.name}
            </span>
            {group.isDemo && <DemoStamp />}
          </span>
          <span className="label mt-1 block text-muted">
            {isMember
              ? `${group.memberCount} member${group.memberCount === 1 ? '' : 's'}${
                  group.role === 'admin' ? ' · admin' : ''
                }`
              : group.status === 'requested'
                ? 'Request pending'
                : 'Not a member'}
          </span>
        </span>
        {group.clearance ? (
          <ClearanceStamp level={group.clearance.level} name={group.clearance.name} />
        ) : (
          <ClearanceStamp level={0} />
        )}
      </span>

      <span className="mt-4 block min-h-[2.5rem]">
        {isMember ? (
          <span className="flex flex-wrap gap-1">
            {group.memberNames.slice(0, 6).map((n) => (
              <span
                key={n}
                className="border border-border px-1.5 py-0.5 text-[11px] text-muted"
              >
                {n}
              </span>
            ))}
            {group.memberNames.length > 6 && (
              <span className="px-1 py-0.5 text-[11px] text-muted">
                +{group.memberNames.length - 6}
              </span>
            )}
          </span>
        ) : (
          // No names were sent to this browser. See Redacted's doc block.
          <RedactedLines seed={group.id} lines={2} />
        )}
      </span>
    </>
  );

  if (isMember) {
    return (
      <button
        onClick={onOpen}
        className="flex min-h-[10rem] flex-col justify-between border-l-2 border border-border bg-surface p-4 text-left transition hover:border-border-strong hover:bg-surface-raised"
        style={{ borderLeftColor: accent }}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className="flex min-h-[10rem] flex-col justify-between border border-l-2 border-dashed border-border bg-surface/40 p-4"
      style={{ borderLeftColor: accent }}
    >
      {inner}
      <JoinRequest groupId={group.id} pending={group.status === 'requested'} />
    </div>
  );
}

function JoinRequest({ groupId, pending }: { groupId: string; pending: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>(
    pending ? 'sent' : 'idle',
  );

  async function ask() {
    setState('sending');
    const res = await fetch(`/api/chats/${groupId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request' }),
    });
    setState(res.ok ? 'sent' : 'failed');
    if (res.ok) router.refresh();
  }

  if (state === 'sent') {
    return <span className="label mt-3 block text-muted">Request pending</span>;
  }

  return (
    <button
      onClick={ask}
      disabled={state === 'sending'}
      className="label mt-3 w-full border border-border-strong py-2 transition hover:bg-surface-raised disabled:opacity-50"
    >
      {state === 'sending' ? 'Asking…' : state === 'failed' ? 'Could not ask' : 'Ask to join'}
    </button>
  );
}

export { Redacted };
