'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/db/browser';
import { describeEvent, summariseTurn, type EventRow, type CallRow } from './event-trace';

/**
 * The agent's thinking and actions, live, in the chat viewport itself.
 *
 * `InternalView` is the full per-chat audit trail, but it is collapsed below
 * the fold — a reviewer has to know to open it. This is the same telemetry,
 * attached to the turn it belongs to and visible without clicking anything: a
 * "thinking…" line that updates as the turn progresses (checking memory,
 * calling a tool, composing a reply), settling into a one-line summary once the
 * turn finishes, with the full ordered trace one click away.
 *
 * It subscribes directly to `agent_events` filtered on THIS turn's id, so a
 * viewer who cannot access the chat gets nothing here for the same reason they
 * get nothing anywhere else — there is no separate authorisation path to get
 * wrong, RLS decides what the subscription can see.
 */
export function TurnTrace({
  turnId,
  initialEvents = [],
  initialCalls = [],
  /** True for the placeholder attached to a message the user just sent, before
   *  it is known whether the agent will speak at all. */
  pendingSend = false,
}: {
  turnId: string;
  initialEvents?: EventRow[];
  /**
   * `llm_calls` rows for cost/tokens. NOT live-updated — matching
   * `InternalView`'s existing behaviour, which also seeds once from the
   * initial fetch. A call that finishes while this trace is on screen shows
   * cost only after the surrounding page reloads. Real, and shared with the
   * full audit panel rather than being a gap unique to this component.
   */
  initialCalls?: CallRow[];
  pendingSend?: boolean;
}) {
  // Seeded once, at mount. TurnTrace only mounts once its turn id is known
  // (ChatSurface withholds it until then), so there is no later point at which
  // an already-mounted instance needs to re-seed from a different initial set.
  const [events, setEvents] = useState(initialEvents);
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
      .channel(`turn:${turnId}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agent_events', filter: `turn_id=eq.${turnId}` },
        (payload) => {
          const row = payload.new as EventRow;
          setEvents((cur) => (cur.some((e) => e.id === row.id) ? cur : [...cur, row]));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [turnId]);

  const turn = useMemo(() => summariseTurn(turnId, events, initialCalls), [turnId, events, initialCalls]);

  // Nothing has arrived at all yet — the RPC that starts the turn and the
  // first agent_events row are not the same write, so there is a brief window
  // with a turnId and zero events. Render nothing rather than an empty shell.
  if (turn.events.length === 0 && !pendingSend) return null;

  // Unfinished and gone quiet: the invocation that was running this turn died
  // without writing a terminal event. Say so, rather than pulsing indefinitely.
  if (turn.stalled) {
    return (
      <p className="mt-1 text-xs text-muted">
        This turn stopped without finishing — the agent never replied.
      </p>
    );
  }

  if (!turn.finished) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
          style={{ background: 'var(--paper)' }}
          aria-hidden
        />
        {turn.events.length === 0 ? 'sent…' : turn.liveStatus}
      </p>
    );
  }

  // Finished and silent (no reply message exists to attach this to) — this is
  // the thesis's other half made visible: not just what the agent said, but
  // that it chose not to.
  if (turn.verdict === 'silent') {
    return (
      <TraceShell open={open} setOpen={setOpen} turn={turn}>
        <p className="text-xs text-muted">
          Quorum stayed quiet{turn.reason ? ` — ${turn.reason}` : turn.rule ? ` (${turn.rule})` : ''}.
        </p>
      </TraceShell>
    );
  }

  return <TraceShell open={open} setOpen={setOpen} turn={turn} />;
}

function TraceShell({
  open,
  setOpen,
  turn,
  children,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  turn: ReturnType<typeof summariseTurn>;
  children?: React.ReactNode;
}) {
  const headline = summaryLine(turn);

  return (
    <div className="mt-1">
      {children}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] text-muted transition hover:text-foreground"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {headline}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 border-l border-border pl-2">
          {turn.events.map((e) => (
            <li key={e.id} className="flex gap-2 text-[11px]">
              <span className="w-36 shrink-0 font-mono text-muted">{e.event_type}</span>
              <span className="min-w-0 flex-1 text-muted">{describeEvent(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function summaryLine(turn: ReturnType<typeof summariseTurn>): string {
  const parts: string[] = [];
  if (turn.rule) parts.push(turn.rule);
  const toolCalls = turn.events.filter((e) => e.event_type === 'tool_invoked').length;
  if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`);
  const blocked = turn.events.some((e) => e.event_type === 'tool_call_blocked_untrusted');
  if (blocked) parts.push('blocked an outward call after untrusted content');
  if (turn.tokens > 0) parts.push(`${turn.tokens} tok · $${turn.cost.toFixed(4)}`);
  return parts.length ? parts.join(' · ') : 'details';
}
