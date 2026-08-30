/**
 * Turning an `agent_events` row into a sentence a reviewer can read.
 *
 * Extracted from `internal-view.tsx` so the SAME wording renders in two places:
 * the full per-chat audit panel, and the inline live trace attached to a turn
 * in the chat viewport itself. Two copies of this switch statement would drift
 * — "3 items surfaced" in one place and "3 kept" in the other is a small
 * inconsistency that undermines the exact thing this panel exists to make
 * trustworthy.
 *
 * Pure functions only. No 'use client', no state — both call sites decide their
 * own rendering and subscription strategy around this.
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

/** One human-readable line for a single event. */
export function describeEvent(e: EventRow): string {
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

export interface TurnSummary {
  turnId: string;
  events: EventRow[];
  /** Cost/tokens joined from llm_calls for this turn, if any were supplied. */
  cost: number;
  tokens: number;
  /** Undefined while running: no gate_evaluated and no research_started yet. */
  verdict: 'respond' | 'silent' | 'research' | undefined;
  rule: string | undefined;
  reason: string | undefined;
  /** True once turn_completed or turn_failed has landed. */
  finished: boolean;
  failed: boolean;
  /** A short, present-tense status line for a turn that is STILL RUNNING. */
  liveStatus: string;
}

/**
 * Fold one turn's events into the shape both the inline trace and the panel
 * need, so "what does a running turn look like" and "what does a finished one
 * look like" are decided once.
 */
export function summariseTurn(turnId: string, events: EventRow[], calls: CallRow[] = []): TurnSummary {
  const ordered = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const gate = ordered.find((e) => e.event_type === 'gate_evaluated');
  const research = ordered.some((e) => e.event_type === 'research_started');
  const completed = ordered.find((e) => e.event_type === 'turn_completed');
  const failed = ordered.find((e) => e.event_type === 'turn_failed');

  const turnCalls = calls.filter((c) => c.turn_id === turnId);
  const cost = turnCalls.reduce((n, c) => n + Number(c.cost_estimate ?? 0), 0);
  const tokens = turnCalls.reduce((n, c) => n + (c.input_tokens ?? 0) + (c.output_tokens ?? 0), 0);

  const verdict = (gate?.payload.verdict as 'respond' | 'silent' | undefined) ?? (research ? 'research' : undefined);

  return {
    turnId,
    events: ordered,
    cost,
    tokens,
    verdict,
    rule: gate?.payload.rule ? String(gate.payload.rule) : research ? 'user-invoked, gate bypassed' : undefined,
    reason: gate?.payload.reason ? String(gate.payload.reason) : undefined,
    finished: Boolean(completed || failed),
    failed: Boolean(failed),
    liveStatus: liveStatusFor(ordered),
  };
}

/**
 * What to show while a turn has not finished — the "thinking" line.
 *
 * Read as the LAST thing the agent is known to be doing, not a fixed "thinking…"
 * label, because a fixed label under a tool call that has been running for ten
 * seconds is not telemetry, it is decoration with the same name.
 */
function liveStatusFor(ordered: EventRow[]): string {
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    switch (e.event_type) {
      case 'turn_started':
        return 'starting…';
      case 'rate_limited':
        return 'rate limited';
      case 'gate_evaluated':
        return e.payload.verdict === 'respond' ? 'composing a reply…' : 'staying quiet…';
      case 'research_started':
        return 'researching…';
      case 'memory_retrieved':
        return 'checking what it can recall here…';
      case 'context_dropped':
        return 'composing a reply…';
      case 'model_call_started':
        return `calling the model (${String(e.payload.purpose ?? 'reply')})…`;
      case 'tool_invoked':
        return `using ${String(e.payload.tool ?? 'a tool')}…`;
      case 'tool_result':
        return 'composing a reply…';
      case 'tool_call_blocked_untrusted':
        return `blocked ${String(e.payload.tool ?? 'a tool')} — continuing without it…`;
      default:
        continue;
    }
  }
  return 'thinking…';
}
