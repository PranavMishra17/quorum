# R11 — LLM reliability

**Band:** B · **Closes:** none directly named, but informs `lib/llm/provider.ts` and the `TODO(verify)` in `config/models.ts` · **Status:** complete

## Question

Quorum's whole agent turn — gate, tool loop, chat reply, memory extraction — runs
through one interface, `lib/llm/provider.ts`, and every call is billed and
logged through `config/models.ts`. Before that interface is written, the
project needs a settled answer to: what does the Claude API guarantee on its
own, what fails silently if the caller doesn't check for it, and where do the
budgets in `config/agent.ts` (`TOOLS.maxCallsPerTurn`, `TOOLS.maxWallClockMs`,
`TIERS.*.timeoutMs`, `TIERS.*.maxRetries`) need to be enforced by Quorum's code
because the API will not enforce them itself. This also has to settle the one
`TODO(verify)` left in `config/models.ts` (Haiku 4.5's `maxOutputTokens`).

## Findings

### 1. Structured outputs — where validation belongs

`output_config.format` (JSON outputs) and `strict: true` (tool schemas) both
guarantee **schema conformance only**: valid JSON, required fields present,
correct types, enum membership, and (for JSON outputs) no extra properties.
They do **not** guarantee semantic correctness — a schema-valid tool call can
still have a stale date, an invalid combination of fields, or a value that
doesn't exist in the domain. JSON Schema's `minimum`/`maximum`/`multipleOf`,
`minLength`/`maxLength`, and cross-field constraints are not enforced by
constrained decoding. [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

**Answer to the sub-question:** semantic validation belongs in the application,
after schema validation, and it is a distinct step — not something a stricter
schema can absorb. For Quorum this means the `judge` tier (gate verdicts,
memory-extraction facts) needs a validation pass *after* the model call
returns schema-valid JSON, before that JSON is trusted for a decision like
"speak" / "write this memory item."

### 2. Tool calling — parallel use, batching results, termination

- Claude can request **multiple tool calls in one `tool_use` stop**; the
  client tool loop must execute all of them and return **all** `tool_result`
  blocks in a single following user message — not one result per round trip.
  Sending a text block after `tool_result` blocks in the same message is
  explicitly called out as a bug pattern that produces empty responses.
  [Stop reasons and handling guide](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- Each individual tool result carries `is_error` (mentioned in tool-use
  handling docs) so a failed tool call is returned to the model as data, not
  silently dropped — the model sees the failure and can retry, ask a
  different way, or give up.
- **Loop termination is client-owned.** `stop_reason: "tool_use"` just means
  "the model wants to call a tool"; nothing in the API caps how many
  request/response round trips a client will do in response. `pause_turn` is
  the one server-enforced loop-termination signal, and it only applies to
  **server tools** (web_search, code_execution, etc.) hitting an internal
  iteration limit — for those, the client is expected to send the response
  back unmodified to continue. Quorum's tools (`web_search`, `web_fetch`,
  `file_read`, `research`) are custom Zod-schema client tools per
  `docs/ARCHITECTURE.md` §`lib/agent/tools/`, so `pause_turn` will not fire
  for them — the loop-cap has to be Quorum's own counter.
  [Stop reasons and handling guide](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)

### 3. Failure-mode table

| Failure mode | Signal | Handling |
|---|---|---|
| Malformed / schema-invalid output | N/A if `strict`/`output_config.format` used — API rejects the invalid completion internally and constrains decoding. Without them: a JSON block that fails `JSON.parse` | Use `strict: true` on all agent tools and `output_config.format` for judge/extraction; still Zod-validate — schema conformance ≠ semantic validity (see #1) |
| Tool timeout | No API signal — this is a client fetch/exec that never returns | Quorum-owned: `TOOLS.perTool[name].timeoutMs`, enforced with `AbortController` around `execute()` |
| Partial tool result | Tool returns incomplete/truncated data with no error | Tool implementation's responsibility to detect and either error (`is_error: true`) or flag truncation in the result content; the model cannot tell malformed-but-present data from complete data |
| Hallucinated tool result | N/A — cannot occur; a `tool_use` block is a request Quorum's code must execute, the model cannot fabricate the `tool_result` content itself | Ensure `execute()` is always actually called for every `tool_use` block seen — a bug that skips execution and echoes back model-authored text as if it were a result would be the injected version of this failure |
| Repeated identical calls | No distinct stop_reason; visible only by diffing tool_use blocks turn over turn | Quorum-owned: cheap to detect (hash name+input, short-circuit or nudge) — not in `config/agent.ts` today, worth a `TOOLS` addition |
| Infinite loop | No API-side cap for client tools | Quorum-owned: `TOOLS.maxCallsPerTurn` (already 6) and `TOOLS.maxWallClockMs` (already 60s) — confirmed these are the only backstop |
| Context overflow | `stop_reason: "model_context_window_exceeded"` | Treat as truncated; per `CONTEXT.dropOrder` in `config/agent.ts`, Quorum drops tool_results → memory → older_history *before* hitting this, so this stop_reason indicates the budget itself needs revisiting, not a per-turn recoverable case |
| Rate limit | HTTP 429, `rate_limit_error`, `retry-after` header present (except the spend-cap variant, which never resolves until next month/limit raise) | SDK auto-retries 2x with exponential backoff honoring `retry-after`; Quorum's `TIERS.*.maxRetries` (1 for most tiers, 0 for `reason`) caps *additional* app-level retries on top of that |
| Provider outage | HTTP 529 `overloaded_error`, or mid-stream SSE `event: error` with `overloaded_error` | Retry with backoff (SDK does 2x by default); Quorum needs a path to `stay_silent`/error-visible fallback since `KILL_SWITCHES.agentEnabled` doesn't auto-flip on transient outage |
| Refusal | `stop_reason: "refusal"`, details in `stop_details` | Anthropic's own guide recommends retrying on a fallback (cheaper) model; for Quorum, a refusal on `chat_response` should degrade to a stock "I can't help with that" agent message and still write the `agent_events` row, never silently drop the turn |

Two stop_reasons not in the sub-question list but load-bearing for Quorum's
loop: `end_turn` (normal) and `stop_sequence`. `max_tokens` is also distinct
from context-window exhaustion — it means the *response itself* hit its cap
and may be mid-tool-call; the guide's own example shows retrying with a raised
`max_tokens` when the truncated block is a `tool_use`.
[Stop reasons and handling guide](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons),
[Claude API errors](https://platform.claude.com/docs/en/api/errors)

### 4. Budgets — API-enforced vs. Quorum-enforced

| Budget | Enforced by |
|---|---|
| `max_tokens` | **API** — hard ceiling per request; the API errors before exceeding it (`max_tokens` stop_reason on truncation, not overrun) |
| Tool-call count per turn | **Quorum** — nothing server-side caps a client-tool loop; `TOOLS.maxCallsPerTurn = 6` is the only guard |
| Wall-clock per turn | **Quorum** — the API has a *per-request* 10-minute non-streaming validation limit (SDKs reject requests expected to exceed it), but nothing bounds a multi-request tool loop's total wall-clock; `TOOLS.maxWallClockMs = 60_000` is Quorum's own |
| Retries | **Both** — the official SDKs retry transient failures (connection errors, 429s, 5xx) up to 2x by default with exponential backoff honoring `retry-after`; `TIERS.*.maxRetries` in `config/models.ts` should be read as *additional application-level* retries layered on top of (or replacing, if the SDK's retry option is set to 0) the SDK default, not the total retry count. This is currently ambiguous in `config/models.ts` — the comment says "provider-wrapper retries" but doesn't say whether `lib/llm/anthropic.ts` should set the SDK's own `maxRetries` to 0 and own retries itself, or let both layers retry (compounding delay before a `judge`-tier 20s timeout is exceeded) |
| Rate limits (RPM/ITPM/OTPM) | **API**, per model, per usage tier — see [Rate limits](https://platform.claude.com/docs/en/api/rate-limits); `retry-after` is authoritative for pacing a retry |
| Spend cap | **API**, but the *spend-cap* 429 has no `retry-after` and won't resolve on retry — the SDK's default retry-with-backoff will burn through `maxRetries` uselessly against it. `error.details.error_code === "enforced_spend_limit_reached"` is the way to distinguish this from an ordinary rate limit and fail fast to `stay_silent` / a kill switch instead of retrying |

### 5. Streaming and partial failure

A model can error **after** returning HTTP 200 and streaming partial content.
This arrives as an SSE `event: error` frame, e.g.
`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
distinct from the normal HTTP error path (which never gets a 200 in the first
place). [Streaming Messages — Error events](https://platform.claude.com/docs/en/build-with-claude/streaming)

For Quorum's `converse` tier (`stream: true`, user-facing): whatever text was
already flushed to the client stays visible — there is no API mechanism to
retract streamed tokens. The turn should be finalized as a truncated message
(with a `context_dropped`-style event, or a dedicated `stream_error` payload
in `agent_events` per the jsonb-extensible design) rather than silently
retried from scratch, because retrying would either duplicate the visible
partial text or require the client to discard and replace it — a UX decision
`docs/ARCHITECTURE.md` doesn't currently make. **This is unresolved** in the
current design and should be an explicit line in `docs/DECISIONS.md`: does a
mid-stream error leave a truncated-but-real message, or does it get replaced?
Given non-negotiable #6 ("failure is visible, not swallowed"), the former is
more consistent with existing project principles, but it is not yet decided.

### 6. `effort` vs. `budget_tokens` — verifying `config/models.ts`

Confirmed against the current API docs:

- `thinking.budget_tokens` is rejected (400) on the Claude 5 family;
  `output_config.effort` is the replacement depth control. Matches the header
  comment in `config/models.ts`.
- Claude Opus 5 has thinking on **by default**, with `display` defaulting to
  `"omitted"` — matches `TIERS.converse`/`TIERS.reason`'s
  `{ kind: 'adaptive', display: 'omitted' | 'summarized' }`.
- Claude Haiku 4.5 is confirmed as a pre-5, `budget_tokens`-only model with no
  `effort` support: the docs state Claude Opus 4.5 is "the only
  extended-thinking-only model that supports effort," which by exclusion
  confirms Haiku 4.5 does not. Matches `supportsEffort: false` and
  `TIERS.reflex.effort: null` in `config/models.ts`.
- **`TODO(verify)` resolved:** the Thinking page's "Output limits" section
  states plainly: *"Claude Fable 5, Claude Mythos 5, Claude Mythos Preview,
  Claude Opus 5, Claude Opus 4.8, Claude Opus 4.7, Claude Sonnet 5, Claude
  Opus 4.6, and Claude Sonnet 4.6 support up to 128k output tokens per
  request. Claude Haiku 4.5, Claude Sonnet 4.5, and Claude Opus 4.5 support up
  to 64k."* This confirms `MODELS['claude-haiku-4-5'].maxOutputTokens: 64_000`
  in `config/models.ts` is correct — the TODO comment can be removed.
  [Thinking — Limits and feature compatibility](https://platform.claude.com/docs/en/build-with-claude/thinking)

One correction worth flagging for `config/models.ts`'s comment style: the
"Claude 5 family" framing is slightly imprecise — Opus 4.8 and 4.7 also run
adaptive-thinking-by-default and reject manual `budget_tokens`, so the
dividing line the docs actually draw is per-model, not strictly per major
version. Not a defect in the current config (all model entries are individual
and correct), just a note that the comment's shorthand ("Claude 5 family")
should not be read as "any future non-5 model behaves like Haiku 4.5."

### 7. Prompt caching — is there a stable prefix worth caching?

Quorum's context-assembly order (`CONTEXT` in `config/agent.ts`: tools →
system → static instructions → memory → history, drop order
`tool_results → memory → older_history`) has a genuinely stable prefix: the
**tool definitions** (`lib/agent/tools/*` schemas passed as `tools` on every
call) and the **system prompt** (gate rules, clearance ladder, agent
persona) do not change within a chat, and often not across chats of the same
type. This is exactly the shape prompt caching wants — `cache_control` placed
on the last block of that stable prefix (tools, then system).

What invalidates it, mapped to Quorum specifics:
- Any change to `lib/agent/tools/*` schemas invalidates the entire cache
  (tools sit first in the hierarchy: tools → system → messages).
- Per-chat `required_clearance_id`/member-derived instructions rendered into
  the system prompt would break the cache *per chat* if clearance context is
  interpolated into system text rather than kept in the tool/memory layer —
  worth keeping clearance-specific text out of the cached system block and
  passing it as a message-level detail instead, to preserve one shared system
  cache across all chats of a given clearance-independent shape.
- The minimum cacheable prefix is model-dependent: 512 tokens for the Claude 5
  family (Opus 5, used for `converse`/`reason`), 1,024 for Sonnet 5 (`judge`),
  4,096 for Haiku 4.5 (`reflex`). Quorum's `reflex` tier prompts (chat titles,
  tool-result compression) are unlikely to reach 4,096 tokens of stable
  prefix, so caching there is probably not worth the write-cost premium
  (1.25x on a 5-minute TTL) unless the reflex system prompt is padded to
  qualify — not recommended.
- Default 5-minute TTL fits Quorum's usage pattern (bursty per-chat activity,
  `GATE.cooldownSeconds: 90` already implies sub-5-minute gaps between calls
  in an active chat); the 1-hour TTL (2x write cost) is not obviously worth it
  unless multiple different chats share the exact same tool+system prefix and
  fire less than every 5 minutes but more than hourly — plausible for a
  low-traffic demo deployment, not clearly justified yet.
  [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

## Application to Quorum

- **`config/models.ts`**: remove the `TODO(verify)` comment on Haiku 4.5's
  `maxOutputTokens` — confirmed correct at 64,000 by the Thinking page's
  output-limits table (finding #6). No value change needed.
- **`lib/llm/provider.ts` / `lib/llm/anthropic.ts`**: the typed error union
  this file needs (per the deliverable) should distinguish at minimum:
  `SchemaInvalid` (should not normally occur with `strict`/`output_config.format`
  but must be handled), `ToolTimeout`, `ToolError` (from `is_error` results),
  `RateLimited` (with `retryAfterMs` from the header), `SpendCapReached`
  (detected via `error.details.error_code === "enforced_spend_limit_reached"`,
  fails fast rather than retrying), `Overloaded`, `Refusal` (with
  `stop_details`), `ContextExceeded` (`model_context_window_exceeded`),
  `MaxTokensTruncated`, and `StreamError` (mid-stream SSE `error` event). Each
  needs a distinct `agent_events.event_type` per non-negotiable #6.
- **`config/agent.ts` — `TOOLS`**: add a repeated-identical-tool-call guard
  (name+input hash short-circuit) — not present today and not covered by any
  API-side mechanism per finding #3.
- **`config/models.ts` — `TierConfig.maxRetries`**: the doc comment should
  state explicitly whether this is retries *on top of* the Anthropic SDK's
  own default (2, exponential backoff, honors `retry-after`) or a total
  override (SDK client constructed with `maxRetries: 0` and Quorum owning all
  retry logic in `anthropic.ts`). Currently ambiguous; recommend the latter —
  a single retry policy in one file is more auditable and avoids compounding
  delay past `TIERS.judge.timeoutMs = 20_000`.
- **`docs/DECISIONS.md`**: the mid-stream-error UX question (finding #5 —
  does a partial `converse`-tier response get kept-and-flagged or
  discarded-and-retried) is not currently an open decision but should be
  added as one; it is a genuine design fork the architecture doc doesn't
  resolve, and it interacts with D-011 (turn idempotency, R8).
- **Prompt caching**: `lib/llm/anthropic.ts` should place `cache_control` on
  the tool-definitions block and, separately, on the end of the static
  system-prompt block (not on any clearance- or chat-specific interpolated
  text), for the `judge` and `converse` tiers where the prefix is likely to
  clear each model's minimum-cacheable-prefix floor (1,024 / 512 tokens
  respectively). Do not bother caching `reflex`-tier calls given Haiku 4.5's
  4,096-token floor.

## Recommendation

This track does not close a numbered open decision in `docs/DECISIONS.md` —
R11 was scoped as informational/config-verification work, not decision-closing
research. It does, however, settle the `TODO(verify)` in `config/models.ts`
and surfaces one decision that should be *added* to `docs/DECISIONS.md`:
**mid-stream partial-failure handling for the `converse` tier.**

**Option chosen:** keep and flag the truncated partial response (write a
`stream_error` `agent_events` row referencing the `message_id`, persist
whatever text streamed before the error, and let the UI render it with a
visible "response interrupted" marker) rather than silently discarding it and
retrying from scratch.

**Strongest argument against this option:** a half-sentence agent message
left in the chat history is confusing context for both the human reader and
any future model call that includes that message in its history — a discard-
and-retry (or discard-and-mark-agent-silent) approach keeps the transcript
clean and matches `GATE.onJudgeFailure: 'stay_silent'`'s fail-closed
philosophy elsewhere in the config. The keep-and-flag choice trades
transcript cleanliness for the "failure is visible, not swallowed"
non-negotiable already stated in `docs/ARCHITECTURE.md` §3 — that principle
argues for keep-and-flag, but it was written about tool/model call *events*,
not about a user-visible truncated chat bubble, so applying it here is an
extrapolation, not a restatement of an existing rule.

**What would settle it definitively:** a decision in `docs/DECISIONS.md`
explicitly trading off transcript integrity vs. the visibility principle,
informed by R8/D-011 (idempotency) since a retry-from-scratch approach must
also decide whether the retry reuses the same `message_id`/`turn_id` or
creates a new one.

## Sources

- [Tool use with Claude — overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) — Anthropic official docs (primary). Parallel tool use, client vs. server tools, `strict` tool schemas.
- [Stop reasons and handling guide](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) — Anthropic official docs (primary). Full `stop_reason` enumeration, `pause_turn`, `refusal`, tool-result batching pattern and the empty-response bug pattern.
- [Claude API errors](https://platform.claude.com/docs/en/api/errors) — Anthropic official docs (primary). HTTP error codes, spend-cap vs. rate-limit 429 distinction, SDK default retry behavior, request-size and long-request guidance.
- [Streaming Messages — Error events](https://platform.claude.com/docs/en/build-with-claude/streaming) — Anthropic official docs (primary). Mid-stream SSE `error` event shape after a 200 response.
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — Anthropic official docs (primary). Schema-conformance vs. semantic-correctness guarantees for `output_config.format` and `strict` tool use.
- [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) — Anthropic official docs (primary). `effort` vs. `budget_tokens` per model, Haiku 4.5 output-token ceiling (resolves the `config/models.ts` TODO), adaptive-thinking defaults.
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — Anthropic official docs (primary). Cache breakpoints, invalidation hierarchy (tools → system → messages), per-model minimum cacheable prefix, TTL and pricing.
- [Rate limits](https://platform.claude.com/docs/en/api/rate-limits) — Anthropic official docs (primary). RPM/ITPM/OTPM enforcement, `retry-after` and `anthropic-ratelimit-*` headers, spend-cap distinct error code, confirmation that `max_tokens` does not affect OTPM accounting.
