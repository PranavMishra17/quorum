'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/db/browser';

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
 */

export interface EventRow {
  id: string;
  turn_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CallRow {
  id: string;
  turn_id: string;
  purpose: string;
  model: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_estimate: string | null;
}

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
    const channel = supabase
      .channel(`events:${chatId}`)
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
    <section className="mt-4 rounded-lg border border-border bg-surface">
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
            <span className="rounded bg-accent-soft px-2 py-0.5 text-accent">
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

interface TurnView {
  turnId: string;
  at: string;
  events: EventRow[];
  cost: number;
  tokens: number;
}

function groupByTurn(events: EventRow[], calls: CallRow[]): TurnView[] {
  const byTurn = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = byTurn.get(e.turn_id) ?? [];
    list.push(e);
    byTurn.set(e.turn_id, list);
  }

  return [...byTurn.entries()]
    .map(([turnId, rows]) => {
      const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const turnCalls = calls.filter((c) => c.turn_id === turnId);
      return {
        turnId,
        at: ordered[0]?.created_at ?? '',
        events: ordered,
        cost: turnCalls.reduce((n, c) => n + Number(c.cost_estimate ?? 0), 0),
        tokens: turnCalls.reduce(
          (n, c) => n + (c.input_tokens ?? 0) + (c.output_tokens ?? 0), 0),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
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

function Turn({ turn }: { turn: TurnView }) {
  const gate = turn.events.find((e) => e.event_type === 'gate_evaluated');
  // A research turn has no gate: the user asked directly, so there is nothing
  // to decide. Without this it would render as "running" forever, which reads
  // as a hung turn rather than as a different kind of turn.
  const research = turn.events.some((e) => e.event_type === 'research_started');
  const verdict = (gate?.payload.verdict as string | undefined) ?? (research ? 'research' : undefined);

  return (
    <li className="rounded border border-border bg-surface-raised p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2 text-xs">
        <span
          className={`rounded px-1.5 py-0.5 font-medium ${
            verdict === 'respond' || verdict === 'research'
              ? 'bg-accent-soft text-accent'
              : 'text-muted'
          }`}
        >
          {verdict ?? 'running'}
        </span>
        {gate?.payload.rule ? (
          <span className="font-mono text-muted">{String(gate.payload.rule)}</span>
        ) : research ? (
          <span className="font-mono text-muted">user-invoked, gate bypassed</span>
        ) : null}
        <span className="ml-auto text-muted">
          {turn.tokens > 0 && `${turn.tokens} tok · $${turn.cost.toFixed(4)}`}
        </span>
      </div>

      {gate?.payload.reason ? (
        <p className="mb-2 text-xs italic text-muted">
          &ldquo;{String(gate.payload.reason)}&rdquo;
        </p>
      ) : null}

      <ul className="space-y-1">
        {turn.events.map((e) => (
          <li key={e.id} className="flex gap-2 text-xs">
            <span className="w-44 shrink-0 font-mono text-muted">{e.event_type}</span>
            <span className="min-w-0 flex-1 text-muted">{describe(e)}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Turn a payload into a sentence a non-engineer can read.
 *
 * The internal view's audience is a reviewer, not an SRE. `memory_retrieved`
 * gets the most careful phrasing because it is the one event that demonstrates
 * the project's central claim, and "kept: 3, filtered_out: 7" does not
 * demonstrate anything to someone who has not read the schema.
 */
function describe(e: EventRow): string {
  const p = e.payload;
  const ms = p.duration_ms ? ` · ${p.duration_ms}ms` : '';

  switch (e.event_type) {
    case 'memory_retrieved': {
      const kept = Number(p.kept ?? 0);
      const filtered = Number(p.filtered_out ?? 0);
      const capped = Number(p.capped_out ?? 0);
      const parts = [`${kept} item${kept === 1 ? '' : 's'} surfaced`];
      if (filtered > 0) {
        parts.push(`${filtered} withheld — not everyone here was in the audience, or the chat is below their clearance`);
      }
      if (capped > 0) parts.push(`${capped} dropped by the per-turn budget`);
      return parts.join('; ') + ms;
    }
    case 'memory_written':
      if (p.summary) return `${p.written} learned, ${p.skipped} skipped${ms}`;
      return `${p.status === 'candidate' ? 'candidate (not retrievable)' : 'active'} · ${p.source_type}${
        p.forced_candidate_by_untrusted_content ? ' · forced to candidate: the turn read untrusted content' : ''
      }`;
    case 'memory_conflict':
      return `superseded an earlier fact${p.genuine_tie ? ' — two stated facts disagreed, the newer won' : ''}`;
    case 'gate_evaluated':
      return `${p.verdict} via ${p.rule}${ms}`;
    case 'model_call_started':
      return `${p.purpose} · ${p.model}`;
    case 'model_call_succeeded':
      return `${p.input_tokens}+${p.output_tokens} tokens · $${Number(p.cost_estimate ?? 0).toFixed(4)}${ms}`;
    case 'model_call_failed':
      return `failed: ${p.error_kind}${ms}`;
    case 'context_dropped':
      return `dropped ${(p.dropped as string[] | undefined)?.join(', ') ?? '—'} to fit the budget`;
    case 'rate_limited':
      return `${p.count}/${p.limit} turns this ${p.window}`;
    case 'turn_completed':
      return p.spoke ? `spoke${ms}` : `stayed quiet (${p.reason})${ms}`;
    case 'turn_failed':
      return `failed: ${p.error_kind}`;
    case 'memory_extraction_failed':
      return `extraction failed — nothing was learned from this turn, and nothing retries`;
    case 'tool_invoked':
      if (p.rejected) return `${p.tool} — input rejected: ${p.reason}`;
      return `${p.tool}${p.externally_observable ? ' · externally observable' : ''}`;
    case 'tool_result':
      if (p.error) return `${p.tool} failed — the turn continued without it${ms}`;
      return (
        `${p.tool}${p.untrusted ? ' · returned UNTRUSTED content, so the turn is now closed to outward-facing tools' : ''}` +
        `${p.citations ? ` · ${(p.citations as string[]).length} citation(s)` : ''}${ms}`
      );
    /**
     * The best single artifact in this panel: an exfiltration attempt that
     * could not happen, rather than one the model declined. If this line is
     * present, D-022 removed the capability mid-turn.
     */
    case 'tool_call_blocked_untrusted':
      return `${p.tool} BLOCKED — ${p.reason}`;
    case 'research_started':
      return `up to ${p.max_steps} steps · tools offered: ${
        (p.tools_offered as string[] | undefined)?.join(', ') || 'none'
      }`;
    case 'research_finished':
      return (
        `${p.steps} step(s), stopped by ${String(p.stopped_by).replace('_', ' ')}` +
        `${p.touched_untrusted_content ? ' · read untrusted content' : ''}${ms}`
      );
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 120) : '';
  }
}
