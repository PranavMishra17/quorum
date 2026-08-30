/**
 * Agent behaviour configuration.
 *
 * Everything here is a number or a threshold that someone will want to argue
 * about. Keeping them in one file means the argument happens in a code review
 * of this file, not scattered across the pipeline as magic constants.
 *
 * Rule for this file: values only, no logic. If a value needs a branch, the
 * branch belongs in the module that consumes it.
 */

// ---------------------------------------------------------------------------
// Response gate — "should the agent speak?"
// ---------------------------------------------------------------------------

export const GATE = {
  /**
   * After the agent speaks in a chat, it stays silent for this long unless
   * something is directed at it explicitly (mention / reply / agent-chat).
   * Prevents the agent turning a group into a monologue.
   */
  cooldownSeconds: 90,

  /**
   * How many recent messages the judge sees when the deterministic chain does
   * not produce a verdict. Small on purpose: the judge decides whether to
   * speak, not what to say.
   */
  judgeContextMessages: 8,

  /**
   * The judge is biased toward silence. It must clear this confidence to
   * speak. An agent that is quiet slightly too often is much better than one
   * that interjects; the failure modes are not symmetric.
   */
  judgeSpeakThreshold: 0.7,

  /**
   * Fail-closed default when the judge errors, times out, or returns junk.
   * Silence is the safe failure: the chat still works and the user can @ the
   * agent to force a response.
   */
  onJudgeFailure: 'stay_silent',

  /** Names the agent answers to. Matched case-insensitively, word-boundary. */
  mentionTokens: ['@quorum', '@agent', 'quorum'],
} as const;

// ---------------------------------------------------------------------------
// Rate limiting — sits above the gate, applies even to explicit mentions
// ---------------------------------------------------------------------------

export const RATE_LIMITS = {
  agentTurnsPerChatPerMinute: 10,
  agentTurnsPerUserPerMinute: 20,
  /** Belt-and-braces cap so a runaway loop cannot drain the key overnight. */
  agentTurnsPerChatPerHour: 120,
  messagesPerUserPerMinute: 60,
} as const;

// ---------------------------------------------------------------------------
// Memory — retrieval, extraction, lifecycle
// ---------------------------------------------------------------------------

export const MEMORY = {
  /**
   * Retrieval order is FILTER -> RANK -> CAP, and the caps below apply only
   * after the authorisation filter has already run in SQL. Capping before
   * filtering is how leaks happen.
   */
  retrieval: {
    /** Total items handed to the model in one turn. */
    globalItemCap: 24,
    /**
     * Per-subject cap. In a 20-person group, one heavily-discussed member
     * must not crowd out the other nineteen.
     */
    perSubjectCap: 3,
    /** Cosine-similarity floor. Below this, an item is noise, not context. */
    similarityFloor: 0.3,
    /** Score weights. Must sum to 1.0 — asserted in tests. */
    weights: {
      similarity: 0.6,
      recency: 0.2,
      /** Subject has spoken in the recent turns of this chat. */
      speakerPresence: 0.2,
    },
    /** Half-life for the recency component. */
    recencyHalfLifeDays: 30,
  },

  extraction: {
    /**
     * Below this, an item is written as `candidate` and is NEVER retrieved.
     * It exists so the decision is auditable, not so it is used.
     */
    confidenceThreshold: 0.6,
    /** Cap per turn. Stops one chatty message becoming forty memory rows. */
    maxItemsPerTurn: 5,
    /** How many recent messages extraction reads. */
    contextMessages: 12,
    /**
     * Extraction runs AFTER the response is delivered, never inline. Keeps
     * the user-visible turn fast and off the serverless timeout cliff.
     */
    deferred: true,
  },

  lifecycle: {
    /**
     * Default TTL for facts flagged time-sensitive at extraction
     * (current location, what someone is working on this week).
     * Null TTL = durable fact, no expiry.
     */
    volatileTtlDays: 30,
    /**
     * Conflict resolution is deterministic and ordered — the model is never
     * asked which fact it prefers, because that is not reproducible.
     *   1. stated-by-subject outranks inferred-about-subject
     *   2. within the same source type, newer outranks older
     *   3. a genuine tie writes a `memory_conflict` event rather than
     *      silently picking one
     */
    statedOutranksInferred: true,
  },
} as const;

// ---------------------------------------------------------------------------
// Context assembly — what actually reaches the model
// ---------------------------------------------------------------------------

export const CONTEXT = {
  /**
   * Soft budget for the assembled prompt. Well under the 1M window on
   * purpose: cost and precision degrade long before the window does.
   */
  tokenBudget: 24_000,
  /** Recent messages included verbatim. */
  historyMessages: 30,
  /**
   * Drop order when over budget. Anything dropped writes a `context_dropped`
   * event so the internal view can show what the agent did NOT see.
   */
  dropOrder: ['tool_results', 'memory_items', 'older_history'],
} as const;

// ---------------------------------------------------------------------------
// Tools — bounded by construction
// ---------------------------------------------------------------------------

export const TOOLS = {
  /** Hard cap on tool calls in one agent turn. Loop guard. */
  maxCallsPerTurn: 6,
  /** Wall-clock ceiling for the whole tool loop. */
  maxWallClockMs: 60_000,
  perTool: {
    web_search: { maxUses: 3, timeoutMs: 15_000 },
    web_fetch: { maxUses: 3, timeoutMs: 15_000, maxContentTokens: 8_000 },
    file_read: { maxUses: 5, timeoutMs: 10_000, maxBytes: 5_000_000 },
    research: { maxSteps: 5, timeoutMs: 180_000 },
  },
  /**
   * Content returned by a tool is UNTRUSTED DATA, never instructions. It is
   * fenced with provenance before it reaches the model, and a tool result can
   * never itself authorise a further privileged tool call.
   * See research track R7 (prompt injection).
   */
  untrustedContentFence: {
    open: '<untrusted_tool_content source="{source}">',
    close: '</untrusted_tool_content>',
  },
} as const;

// ---------------------------------------------------------------------------
// Clearance ladder — the second authorisation axis
// ---------------------------------------------------------------------------

/**
 * Deliberately a small integer ladder rather than a real entitlement system.
 * It is enough to demonstrate that clearance is INDEPENDENT of membership:
 * the same set of people can share a level-3 and a level-1 chat, and a fact
 * learned in the former must not surface in the latter.
 */
export const CLEARANCES = [
  { key: 'general', name: 'General', level: 0 },
  { key: 'internal', name: 'Internal', level: 1 },
  { key: 'external_audit', name: 'External Audit', level: 2 },
  { key: 'internal_exec', name: 'Internal Exec', level: 3 },
] as const;

export const DEFAULT_CLEARANCE_LEVEL = 0;

// ---------------------------------------------------------------------------
// Kill switches
// ---------------------------------------------------------------------------

/**
 * The supplied Anthropic key is short-lived and rate-limited. These let the
 * app degrade to a plain chat rather than erroring, without a redeploy.
 */
export const KILL_SWITCHES = {
  agentEnabled: process.env.AGENT_ENABLED !== 'false',
  memoryWriteEnabled: process.env.MEMORY_WRITE_ENABLED !== 'false',
  toolsEnabled: process.env.TOOLS_ENABLED !== 'false',
} as const;
