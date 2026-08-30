/**
 * Agent event types.
 *
 * `agent_events.payload` is jsonb, so adding a variant here is a type change
 * and never a migration — one of the seams that lets later work land without
 * disturbing earlier work.
 *
 * Step-boundary events carry `duration_ms` in the payload rather than being
 * split into paired `_started` / `_completed` rows: one insert per step, and no
 * self-join needed to compute how long anything took.
 */

export type AgentEventType =
  // --- gate ---
  | 'gate_evaluated'
  // --- memory ---
  | 'memory_retrieved'
  | 'memory_written'
  | 'memory_conflict'
  | 'memory_extraction_failed'
  // --- context ---
  | 'context_dropped'
  // --- model ---
  | 'model_call_started'
  | 'model_call_succeeded'
  | 'model_call_failed'
  | 'stream_error'
  | 'refusal'
  | 'spend_cap_reached'
  // --- tools ---
  | 'tool_invoked'
  | 'tool_result'
  | 'tool_call_blocked_untrusted'
  // --- turn ---
  | 'turn_started'
  | 'turn_completed'
  | 'turn_resumed'
  | 'turn_failed'
  | 'rate_limited';

export interface GateEvaluatedPayload {
  verdict: 'respond' | 'silent';
  /** Which rule decided it. 'judge' means the chain fell through. */
  rule: string;
  reason: string;
  duration_ms: number;
}

export interface MemoryRetrievedPayload {
  /** Items handed to the model. */
  kept: number;
  /**
   * Items the authorisation filter removed. This number is the entire point of
   * the internal view: a filter you cannot see working is indistinguishable
   * from one that is not running.
   */
  filtered_out: number;
  /** Removed by the caps, not by authorisation. Kept separate deliberately. */
  capped_out: number;
  duration_ms: number;
}

export interface ModelCallPayload {
  purpose: string;
  model: string;
  tier: string;
  llm_call_id: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_estimate?: number;
  error_kind?: string;
}

export interface ContextDroppedPayload {
  /** What was dropped, in the order config/agent.ts specifies. */
  dropped: string[];
  token_budget: number;
  estimated_tokens: number;
}

export interface TurnPayload {
  reason?: string;
  duration_ms?: number;
  resumed_from_request_id?: string;
}

/** Payloads are open — a new event type must not require editing this file. */
export type AgentEventPayload = Record<string, unknown>;
