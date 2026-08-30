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

    /**
     * MEMORY-WRITE PLANTING — a delayed-fuse leak unique to a system that
     * persists what it learns.
     *
     * Extraction reads the model's own reply. An injected instruction in a
     * fetched document that makes the model assert a false fact about a user
     * plants that lie into `memory_items`, where it then surfaces — correctly
     * authorised, indefinitely — in every chat the audience rule permits. The
     * general prompt-injection literature does not cover this, because general
     * systems do not remember.
     *
     * Mitigation: anything extracted from a turn that touched untrusted tool
     * content is forced to `inferred` and below the confidence threshold, so it
     * lands as `candidate` and is never retrieved. It stays visible in the
     * internal view, so the attempt is auditable rather than merely dropped.
     */
    untrustedTurnPolicy: {
      forceSourceType: 'inferred',
      forceStatus: 'candidate',
    },
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
    /**
     * Extracting a schema from a document is a MODEL call inside a tool call,
     * so its budget has to leave room for the outer turn. Two uses, because a
     * legitimate need for a third is more likely a loop than a document.
     */
    document_extract: { maxUses: 2, timeoutMs: 45_000 },
    email_search: { maxUses: 2, timeoutMs: 15_000 },
    calendar_list: { maxUses: 2, timeoutMs: 15_000 },
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

// ---------------------------------------------------------------------------
// Document extraction — bounds applied AROUND a parser, not inside it
// ---------------------------------------------------------------------------

/**
 * See `lib/files/extract-text.ts` for why each of these exists. In short: a
 * parsing library will bound neither how much text it produces nor how many
 * pages it walks, and both are cheap for an uploader to inflate.
 *
 * `maxExtractedChars` is the one that matters most. A 200 KB `.docx` of one
 * repeated glyph decompresses to megabytes of text, and the file does not have
 * to be malicious to be pathological — an exported email thread will do it.
 */
export const DOCUMENTS = {
  /** Ceiling on text handed back from any extractor, before prompt budgeting. */
  maxExtractedChars: 120_000,
  /** Pages read from a PDF. Beyond this the agent is told what it did not read. */
  maxPdfPages: 40,
  /**
   * Characters of a document fed to the schema-extraction model call.
   * Smaller than the read ceiling on purpose: extraction wants the front matter
   * of a contract, and a 120k-char prompt for a list of parties is waste.
   */
  maxCharsForSchemaExtraction: 40_000,
  /** Fields the model may be asked to pull out in one call. */
  maxSchemaFields: 12,
} as const;

// ---------------------------------------------------------------------------
// External connectors — read-only, per-user, and deliberately narrow
// ---------------------------------------------------------------------------

/**
 * Bounds for the Google connectors. See `docs/EMAIL-SETUP.md` for the
 * authorisation design and for what this deliberately does not solve.
 *
 * `chatTypes` is the one to read twice. A mailbox has no audience snapshot — it
 * is one person's data with no notion of who else is in the room — so a search
 * run in a group puts Alice's mail in front of everyone in that group. Memory
 * has a rule for this; an inbox does not. Restricting the connectors to DMs and
 * agent chats is the honest v1 answer, and it is enforced at registration so
 * the model is never even offered the tool in a group.
 */
export const CONNECTORS = {
  /** Where a connector tool may be offered at all. */
  chatTypes: ['dm', 'agent'] as readonly string[],

  email: {
    /** Messages returned per search. Small: this answers questions, not exports. */
    maxResults: 10,
    /** Google's snippet is ~200 chars; this is the ceiling we enforce ourselves. */
    maxSnippetChars: 300,
    /** Ceiling on the model-authored search query, which is interpolated into a URL. */
    maxQueryChars: 200,
  },

  calendar: {
    maxResults: 20,
    /**
     * How far a single query may reach. An unbounded window is a calendar
     * export; a bounded one answers "what does my week look like".
     */
    maxWindowDays: 60,
  },
} as const;

/**
 * The serverless invocation ceiling the turn route runs under.
 *
 * It lives here because THREE numbers have to fit inside it and they were, until
 * this was written, each assuming a different one. `TIERS.reason.timeoutMs`
 * carried a comment about staying "under the platform ceiling" while the route
 * that runs it declared 60 seconds — so the deep tier's budget was four times
 * the container it ran in, which is dead configuration of exactly the kind the
 * TOOLS comment above warns about.
 *
 * The agent turn runs in `after()`, and `after()` work counts toward the
 * function's duration. So this is the real ceiling on a turn, not a suggestion.
 * Deployment plans cap it lower (Vercel Hobby in particular); if the platform
 * truncates a turn, the reply is lost and the deferred memory extraction with
 * it. Lower this rather than discovering that in production.
 *
 * Asserted against the tier and research budgets in tests/config.test.ts.
 */
export const PLATFORM = {
  turnRouteMaxDurationSeconds: 300,
} as const;

/**
 * The research turn is USER-INVOKED and runs as its own turn type — it is not
 * part of the automatic tool loop above, which is why its budget legitimately
 * exceeds TOOLS.maxWallClockMs. Its ceiling must stay under
 * TIERS.reason.timeoutMs so the model call is never the thing that dies first,
 * and under the platform ceiling so the container is never what kills it.
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
 * the same set of people can share a level-3 and a level-0 chat, and a fact
 * learned in the former must not surface in the latter.
 *
 * ONE DIMENSION ONLY: how sensitive the material is. Nothing here names a team,
 * a department, or who is in the room.
 *
 * An earlier version had `external_audit` and `internal_exec` as rungs, which
 * silently conflated two dimensions — "External Audit" describes *who is
 * present*, not *how sensitive the content is*, and a monotone integer cannot
 * express both. It also produced a concrete bug: an `internal` fact was
 * eligible to surface into an `external_audit` chat purely because 2 > 1.
 * Team membership is what `chat_members` is for. See D-023.
 */
export const CLEARANCES = [
  { key: 'general', name: 'General', level: 0 },
  { key: 'internal', name: 'Internal', level: 1 },
  { key: 'confidential', name: 'Confidential', level: 2 },
  { key: 'restricted', name: 'Restricted', level: 3 },
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
