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
   * The judge returns a DISCRETE verdict, not a confidence score.
   *
   * There was a `judgeSpeakThreshold: 0.7` here. Research R5 killed it: LLM
   * self-reported confidence is not calibrated well enough to threshold on, so
   * comparing a model-authored float to 0.7 is theatre dressed as rigour. It
   * also contradicted the README, which already said "a verdict plus a one-line
   * reason" — the prose was right and the config was wrong.
   *
   * Obtained via the API's structured-outputs surface (`output_config.format`),
   * not a forced tool call. See D-020.
   */
  judgeVerdicts: ['respond', 'silent'] as const,

  /**
   * Fail-closed default when the judge errors, times out, or returns junk.
   * Silence is the safe failure: the chat still works and the user can @ the
   * agent to force a response.
   */
  onJudgeFailure: 'silent',

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
    /**
     * Relevance floor. Below this, an item is noise, not context.
     *
     * NOTE: D-004 closed with NO vector provider in v1, so this scores
     * `ts_rank` output (lexical), not cosine similarity. The number was chosen
     * for a cosine scale and must be re-tuned against real `ts_rank` values
     * before it means anything. Recorded here rather than silently carried over.
     */
    relevanceFloor: 0.3,
    /** Score weights. Must sum to 1.0 — asserted in tests. */
    weights: {
      /** Lexical relevance in v1; semantic if D-004 is ever reopened. */
      relevance: 0.6,
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
  dropOrder: ['tool_results', 'memory', 'older_history'],
} as const;

// ---------------------------------------------------------------------------
// Tools — bounded by construction
// ---------------------------------------------------------------------------

export const TOOLS = {
  /** Hard cap on tool calls in one agent turn. Loop guard. */
  maxCallsPerTurn: 6,
  /** Wall-clock ceiling for the whole automatic tool loop. */
  maxWallClockMs: 60_000,

  /**
   * Every entry's `timeoutMs` must be <= `maxWallClockMs`. A tool budgeted for
   * longer than the loop containing it means one of the two numbers is dead
   * code — which is exactly what `research` was before R7/R9 caught it.
   * Asserted in tests/config.test.ts.
   */
  perTool: {
    web_search: { maxUses: 3, timeoutMs: 15_000 },
    web_fetch: { maxUses: 3, timeoutMs: 15_000, maxContentTokens: 8_000 },
    file_read: { maxUses: 5, timeoutMs: 10_000, maxBytes: 5_000_000 },
  },

  /**
   * Content returned by a tool is UNTRUSTED DATA, never instructions.
   *
   * The fence is provenance labelling, and labelling alone is NOT a defence —
   * R7 is explicit that delimiting is defence-in-depth, not a mitigation. The
   * actual structural control is `postUntrustedAllowlist` below, enforced in
   * lib/agent/orchestrator.ts. Previously this comment claimed a tool result
   * "can never authorise a further privileged call" while nothing enforced it.
   */
  untrustedContentFence: {
    open: '<untrusted_tool_content source="{source}">',
    close: '</untrusted_tool_content>',
  },

  /**
   * Least-privilege turn scoping (D-022). Once a turn has ingested untrusted
   * tool content, it may only call tools on this allowlist for the rest of the
   * turn. This is what makes the untrusted/trusted boundary structural rather
   * than a request that the model behave.
   */
  postUntrustedAllowlist: [] as readonly string[],
} as const;

/**
 * The research tool is USER-INVOKED and runs as its own turn type — it is not
 * part of the automatic tool loop above, which is why its budget legitimately
 * exceeds TOOLS.maxWallClockMs. Its ceiling must stay under
 * TIERS.reason.timeoutMs so the model call is never the thing that dies first.
 */
export const RESEARCH_TOOL = {
  maxSteps: 5,
  timeoutMs: 180_000,
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
