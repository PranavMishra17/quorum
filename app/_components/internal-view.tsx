'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/db/browser';
import { describeEvent, summariseTurn, type EventRow, type CallRow } from './event-trace';

export type { EventRow, CallRow };

/**
 * The agent internal view.
 *
 * A memory isolation rule you cannot see working is indistinguishable from one
 * that is not running. This panel is where the claim becomes checkable: it
 * shows, per turn, which gate rule fired and why, how many memory items
 * surfaced, and — the number that matters — **how many the authorisation filter
 * withheld**.
 *
 * It reads `agent_events` and `llm_calls` directly through the browser client,
 * so RLS decides what a given viewer sees. A non-member gets an empty panel for
 * the same reason they get an empty chat.
 *
 * This is the FULL audit trail across every turn in the chat, kept collapsed by
 * default. `TurnTrace` (in this same directory) is the lighter-weight sibling
 * attached inline to each message in the viewport — both read the same
 * `describeEvent`/`summariseTurn` so the wording never disagrees between them.
 */
export function InternalView({
  chatId,
  initialEvents,
  initialCalls,
}: {
  chatId: string;
  initialEvents: EventRow[];
  initialCalls: CallRow[];
}) {
  const [events, setEvents] = useState(initialEvents);
  const [calls] = useState(initialCalls);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    /**
     * The random suffix on the topic exists because of a real race, not
     * paranoia: Next dev double-invokes client effects (mount, cleanup, mount
     * again), and `removeChannel()`'s leave handshake is async. If the second
     * mount asks for the SAME topic before the first one's leave has resolved,
     * the client's internal channel registry hands back the
     * ALREADY-SUBSCRIBED instance from the first mount instead of a fresh one,
     * and calling `.on()` on it throws "cannot add postgres_changes callbacks
     * ... after subscribe()". A unique suffix per effect invocation makes
     * every subscription attempt its own topic, so the two mounts can never
     * collide — found by actually running the app and sending a message, not
     * by reading the Realtime docs.
     */
    const channel = supabase
      .channel(`events:${chatId}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agent_events', filter: `chat_id=eq.${chatId}` },
        (payload) => {
          const row = payload.new as EventRow;
          setEvents((cur) => (cur.some((e) => e.id === row.id) ? cur : [row, ...cur]));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [chatId]);

  const turns = useMemo(() => groupByTurn(events, calls), [events, calls]);
  const totals = useMemo(() => summarise(events, calls), [events, calls]);

  return (
    <section className="mt-4 border border-border bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="text-sm font-medium">
          What the agent did
          <span className="ml-2 font-normal text-muted">({turns.length} turns)</span>
        </span>
        <span className="flex items-center gap-3 text-xs text-muted">
          {totals.withheld > 0 && (
            <span className="bg-surface-raised px-2 py-0.5 text-foreground">
              {totals.withheld} memory withheld
            </span>
          )}
          <span>${totals.cost.toFixed(4)}</span>
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          {turns.length === 0 ? (
            <p className="py-4 text-xs text-muted">
              Nothing yet. Every turn is recorded here, including the ones where
              the agent decided to stay quiet.
            </p>
          ) : (
            <ol className="space-y-4">
              {turns.map((t) => (
                <Turn key={t.turnId} turn={t} />
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function groupByTurn(events: EventRow[], calls: CallRow[]) {
  const byTurn = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = byTurn.get(e.turn_id) ?? [];
    list.push(e);
    byTurn.set(e.turn_id, list);
  }

  return [...byTurn.entries()]
    .map(([turnId, rows]) => summariseTurn(turnId, rows, calls))
    .sort((a, b) => {
      const aAt = a.events[0]?.created_at ?? '';
      const bAt = b.events[0]?.created_at ?? '';
      return bAt.localeCompare(aAt);
    });
}

function summarise(events: EventRow[], calls: CallRow[]) {
  let withheld = 0;
  for (const e of events) {
    if (e.event_type === 'memory_retrieved') {
      withheld += Number(e.payload.filtered_out ?? 0);
    }
  }
  return {
    withheld,
    cost: calls.reduce((n, c) => n + Number(c.cost_estimate ?? 0), 0),
  };
}

function Turn({ turn }: { turn: ReturnType<typeof summariseTurn> }) {
  return (
    <li className="border border-border bg-surface-raised p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2 text-xs">
        <span
          className={` px-1.5 py-0.5 font-medium ${
            turn.verdict === 'respond' || turn.verdict === 'research'
              ? 'bg-surface-raised text-foreground'
              : 'text-muted'
          }`}
        >
          {turn.verdict ?? (turn.finished ? 'silent' : 'running')}
        </span>
        {turn.rule ? <span className="font-mono text-muted">{turn.rule}</span> : null}
        <span className="ml-auto text-muted">
          {turn.tokens > 0 && `${turn.tokens} tok · $${turn.cost.toFixed(4)}`}
        </span>
      </div>

      {turn.reason ? (
        <p className="mb-2 text-xs italic text-muted">&ldquo;{turn.reason}&rdquo;</p>
      ) : null}

      <ul className="space-y-1">
        {turn.events.map((e) => (
          <li key={e.id} className="flex gap-2 text-xs">
            <span className="w-44 shrink-0 font-mono text-muted">{e.event_type}</span>
            <span className="min-w-0 flex-1 text-muted">{describeEvent(e)}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}
