# R00 — Band B/C synthesis: what the research forces

**Inputs:** R7–R16 (`research/reports/`), `docs/BUILD-PLAN.md`,
`docs/ARCHITECTURE.md`, `config/agent.ts`, `config/models.ts`.
**Status:** decisions, not a literature review. Every line below is either a
change to make or a claim to stop making.

Read this instead of the ten reports. Read the reports only for the citation
behind a line you want to argue with.

---

## 1. One decision per track

| Track | The decision it forces |
|---|---|
| **R7 — prompt injection** | Tool privilege is **turn-scoped**: ship `externally_observable: boolean` on the `Tool` interface and enforce in `orchestrator.ts` that once a turn has ingested untrusted tool content, no further externally-observable call may fire outside a fixed allowlist. The XML fence already in `config/agent.ts` is defence-in-depth and is **never** the claim. |
| **R8 — idempotency** | At-least-once delivery + idempotent turn, keyed on a **client-generated** `client_message_id` under a permanent UNIQUE constraint; `turn_id` must be **persisted on `messages`** (nothing currently stores it) and the `llm_calls` row must be written **before** the model call, not after. Closes D-011's *shape*; the resume path is unproven. |
| **R9 — async on Vercel** | `after()` from `next/server` inside the same invocation, with an explicit `export const maxDuration` on the turn route. **No queue, no pgmq.** The entire durability story is one `memory_extraction_failed` event — say that out loud rather than implying durability. |
| **R10 — observability** | `request_id` is distinct from `turn_id` and both are required; the trace is `agent_events ⋈ llm_calls` on `turn_id`. **No `traces` table and no `tool_calls` table** — tool spans are paired `agent_events` rows sharing a `tool_call_id` in `payload`. |
| **R11 — LLM reliability** | Quorum owns the **entire** retry policy: construct the Anthropic SDK with `maxRetries: 0` and make `TierConfig.maxRetries` the total. Ship a 10-variant typed error union in `lib/llm/errors.ts`. Mid-stream failure is **keep-and-flag**, not discard-and-retry. |
| **R12 — testing** | RLS is tested with pgTAP under `supabase test db` as the `authenticated` role, and `pnpm test` must be composed (`vitest run && supabase test db`) or a green check is a lie. Three isolation cases are missing and one of them is a live fail-open. |
| **R13 — Next 16 + Supabase** | `proxy.ts` (not `middleware.ts`) and it is **UX only**; `getClaims()` never `getSession()` for any authorisation decision; and **Realtime is a second, separately-answered staleness surface** that D-009 does not currently cover. |
| **R14 — transactions** | The turn's write path is **one `SECURITY DEFINER` Postgres RPC opened at `REPEATABLE READ`**, not a sequence of `supabase-js` calls. `supabase-js` has no multi-statement transaction; the pipeline in ARCHITECTURE §3 is not atomic as drawn. |
| **R15 — canvas** | **SVG, not canvas.** R15 recommends canvas and its own evidence does not support it at a few hundred nodes; canvas costs hand-rolled hit-testing in the feature that is first to be cut. The list view is the accessibility answer, already committed in D-017. |
| **R16 — industry landscape** | **Cite none of it as validation.** Take exactly one thing forward: the *aggregation* caveat — the surfacing rule does not stop a user inferring an unauthorised fact from two authorised answers, and the README must say so. |

---

## 2. Config changes

### `config/agent.ts`

**Wrong — internally contradictory.**

- `TOOLS.perTool.research.timeoutMs: 180_000` exceeds
  `TOOLS.maxWallClockMs: 60_000`. A single tool is permitted three times the
  budget of the whole loop that contains it. One of the two is dead code.
  → **`research.timeoutMs: 45_000`, `research.maxSteps: 3`**, keeping
  `maxWallClockMs: 60_000` intact. If research genuinely needs 180s it belongs
  on the `reason` tier as a user-invoked route with its own budget, not inside
  the turn loop — see the Vercel arithmetic below.

**Missing — R7 has no home in config, and non-negotiable #8 requires one.**

- → **`TOOLS.externallyObservable: Record<string, boolean>`** — per-tool flag,
  the config half of R7's turn-scoping rule.
- → **`TOOLS.postUntrustedAllowlist: readonly string[]`** — the fixed set of
  tool names still callable after untrusted ingest. An empty array is a
  defensible starting value and makes the rule trivially testable.
- → **`TOOLS.maxLoggedToolOutputChars: 2_000`** — R7 channel 4e. Raw untrusted
  tool output must not land verbatim in `agent_events.payload`.
- → **`TOOLS.maxIdenticalCallsPerTurn: 1`** — R11 §3 names repeated-identical
  tool calls as a failure mode with *no* API-side signal and no current guard.
  Detected by hashing `name + JSON.stringify(input)`.

**Unjustified — presumes a decision that is still OPEN.**

- `MEMORY.retrieval.similarityFloor: 0.3` and
  `MEMORY.retrieval.weights.similarity: 0.6` both presume cosine similarity over
  an embedding that D-004 has not chosen. If D-004 resolves to a lexical
  fallback, `0.3` is not a threshold on anything. → Keep the values, but the
  comment must say **"pending D-004; meaningless if ranking is lexical"**, and
  `tests/config.test.ts` must assert the weights sum to 1.0 *and* that the
  lexical path ignores `similarityFloor` rather than silently comparing
  incomparable scores.

**Under-specified.**

- `MEMORY.extraction.deferred: true` does not say *how*. R9 closes this.
  → add **`MEMORY.extraction.mechanism: 'after'`** with a comment naming
  `next/server`'s `after()` and stating the consequence: the work shares the
  invocation's timeout and is **cancelled** if the function times out.

**New section required by R9.**

```ts
export const RUNTIME = {
  /** Vercel Hobby + Fluid Compute ceiling. Route files export this. */
  maxDurationSeconds: 300,
  /** Whole turn incl. deferred extraction. Must leave headroom under the above. */
  turnWallClockBudgetMs: 240_000,
} as const;
```

**Not challenged by any report — leave alone, and say so:** `GATE.*` (all five
values), `RATE_LIMITS.*`, `CONTEXT.*`, `CLEARANCES`, `KILL_SWITCHES`. No Band
B/C research touched these. A synthesis document should not manufacture
authority it does not have.

### `config/models.ts`

- **`TODO(verify)` on Haiku 4.5 `maxOutputTokens`: delete it.** R11 §6 confirms
  64,000 against the Thinking page's output-limits table. The value is correct;
  the comment is now false.
- **`TierConfig.maxRetries` semantics: currently ambiguous, and the ambiguity is
  a live bug.** The Anthropic SDK retries transient failures **2×** by default
  with backoff. Layered on `judge.maxRetries: 1`, a rate-limited judge call can
  burn three attempts against `judge.timeoutMs: 20_000` and blow the gate's
  budget while the config claims one retry. → Doc-comment it as **total**, and
  construct the SDK client in `lib/llm/anthropic.ts` with `maxRetries: 0`.
- **`TIERS.reason.timeoutMs: 300_000`** equals the entire Hobby invocation
  ceiling, leaving zero budget for the rest of the turn — a guaranteed timeout,
  and under `after()` the deferred extraction is *cancelled* when it fires.
  → **`240_000`**, matching `RUNTIME.turnWallClockBudgetMs`.
- **New per-tier field `promptCache: boolean`** (R11 §7). `converse: true`
  (Opus 5, 512-token minimum prefix), `judge: true` (Sonnet 5, 1,024),
  `reflex: false` (Haiku 4.5's 4,096-token floor will not be cleared by a chat
  title prompt; the 1.25× write premium would be pure loss), `reason: true`.
  With it, a one-line rule in the header comment: **clearance- and chat-specific
  text must never be interpolated into the cached system block**, or the cache
  fragments per chat and the feature is worthless.
- **Header comment correction:** "On the Claude 5 family, `thinking.budget_tokens`
  is REMOVED" is imprecise — Opus 4.8 and 4.7 behave the same way. The line the
  docs draw is per-model, not per-major-version. Not a defect (every entry is
  individually correct), but the shorthand must not be read as "any non-5 model
  behaves like Haiku 4.5."

---

## 3. Schema changes

Additive migrations only. Nothing here edits an applied migration.

### Columns that must exist and currently do not

| Table | Add | Why |
|---|---|---|
| `messages` | `turn_id uuid` | ARCHITECTURE §3 says "duplicate? **return existing turn**" — but nothing maps `client_message_id` → `turn_id`. Without this column the idempotency check has nothing to return. **A hole in the design as drawn, not an optimisation.** (R8) |
| `agent_events` | `request_id uuid not null` | Distinct from `turn_id`. R10 could not settle whether this earns its cost; R8 settles it — a retry **resumes the same `turn_id`** under a new request, so without `request_id` the trace cannot tell "one turn, two delivery attempts" from "one attempt". (R10 §1 + R8 §2) |
| `llm_calls` | `request_id uuid not null` | Same. |
| `llm_calls` | `status text` (`started` / `succeeded` / `failed`), `started_at`, `finished_at` | The row must be written **before** the network call so a retry can detect "already billed" instead of paying twice. `latency_ms` alone cannot be written before the call returns. (R8 §5) |

### Indexes

```sql
llm_calls    (turn_id)               -- checked before every model call; hot path
agent_events (turn_id, created_at)   -- the trace join, in event order
```

`messages (chat_id, client_message_id) UNIQUE` is already specified and is
confirmed correct — with the addition that it carries **no TTL**. Stripe prunes
keys at 24h because keys are scarce in a payments system; a message id on a row
that persists anyway is not. (R8 §4)

### Not added, deliberately

- **No `tool_calls` table.** Tool spans are a `tool_invoked` / `tool_result`
  pair of `agent_events` rows sharing a `tool_call_id` inside `payload`. R10
  recommends the table and then argues against itself; the counter-argument wins
  on the extensibility charter's own terms (a new event type is no migration;
  a new table is).
- **No `traces` table.** The trace *is* the join.
- **No `pgmq` queue table.** (R9 §3)

### `agent_events.payload` conventions (no migration)

Every step-boundary event carries **`duration_ms`** in its payload rather than
paired `_started` / `_completed` rows — one insert per step, no join to compute
a duration. New event types, all payload-only:

`model_call_started` · `memory_extraction_failed` · `stream_error` ·
`tool_call_blocked_untrusted` · `refusal` · `spend_cap_reached` · `turn_resumed`

Each of R11's ten error variants needs its own `event_type` per non-negotiable
#6. `spend_cap_reached` is not cosmetic: the spend-cap 429 carries no
`retry-after` and never resolves on retry, so it must be detected via
`error.details.error_code === "enforced_spend_limit_reached"` and fail fast
instead of exhausting the retry budget.

### The one thing that needs a Postgres function, not a column

**`send_message_and_start_turn(...)` in migration `0004`** — `SECURITY DEFINER`,
opened at `REPEATABLE READ`, doing `INSERT ... ON CONFLICT DO NOTHING` on
`(chat_id, client_message_id)` and returning the resolved `turn_id`. Called once
from `lib/db/scoped-agent.ts` via `.rpc()`.

This is not a nicety. `supabase-js` **has no multi-statement transaction**; every
`.from()` call is its own implicit transaction, and Supavisor's transaction-mode
pooling means session state does not survive between two calls. The pipeline in
ARCHITECTURE §3 — idempotency check, then persist, then build context — is
**three separate transactions** as currently drawn. (R14 §5)

The same mechanism answers **D-009(c)**: one `REPEATABLE READ` snapshot for the
turn means `chat_members` and `memory_audience` cannot shift underneath it. Cost:
every write path through that function now needs a `40001` retry loop. R14 is
honest that D-009(a) — snapshot at turn start, accept staleness — may be the
better trade; that call belongs to R2, not here.

### Missing from the file fan-out entirely

- **`app/auth/callback/route.ts`** — the PKCE `exchangeCodeForSession` endpoint.
  Not in ARCHITECTURE §4's `app/` table. Must return
  `Cache-Control: private, no-store` or a CDN can serve one user's session
  response to another. (R13 §2–3)
- **`proxy.ts`** — not `middleware.ts`. Next 16 renamed the file and the export.
  Also absent from the fan-out table. (R13 §8)

---

## 4. Build-plan corrections

**Hour 0–1 — the migration list is short by one.** The block says migrations
`0001`–`0004`, but hour 2.5–3.5 requires `llm_calls` and `agent_events` to
exist. **`0005_agent_events.sql` must land in the 0–1 block.**

**Hour 0–1 — add a Docker / Supabase-CLI check.** R12's RLS strategy is
`supabase test db`. If Docker is unavailable wherever `pnpm check` runs, the
whole RLS-testing plan changes to testcontainers, and discovering that at hour
8.5 is exactly the "hosting surprise at hour eleven" this plan exists to
prevent. Verify it at hour zero, alongside the deploy.

**Hour 1–2.5 — under-estimated by roughly 30 minutes.** The messages route is
specified as a route handler; R14 makes it a route handler **plus** a Postgres
RPC with `ON CONFLICT` and an isolation level. That is SQL work not currently
budgeted.

**Hour 1–2.5 — a "tier 3" concern is actually due here.** R7's exfiltration
channel 4c (the EchoLeak / Slack-AI pattern: a data-bearing URL in a rendered
message beacons the moment *any* participant's browser paints it) fires in the
**message rendering component**, which ships at hour 1–2.5. It requires no tool,
no agent, and no tier-3 code. **Auto-loading remote images and link unfurling
must be off from the first render**, not retrofitted when tools arrive.

**Hour 2.5–3.5 — under-estimated.** "provider.ts + anthropic.ts + llm_calls +
log.ts" in one hour now also carries: a ten-variant typed error union, SDK
`maxRetries: 0` plus a hand-owned retry policy, spend-cap detection, mid-stream
SSE error handling, `cache_control` breakpoint placement, and writing the
`llm_calls` row before the call. **1.5h**, taken from tier 3.

**Hour 5–6 — move the fixture builder earlier.** `tests/fixtures/graph.ts`
(2–3 users, a DM and a group with overlapping-but-not-identical membership, a
post-learn membership change, two clearance levels) does not exist and is a
prerequisite for hour 6–7. Build it in the 5–6 block with the migration.

**Hour 6–7 — "the five isolation tests" is now at least eight, plus a property
test.** R12 §5 identifies three missing cases; §6 adds a fast-check monotonicity
property. `fast-check` is not in `devDependencies`. **1.5h**, and add the three
`it.todo` entries *before* tier 2 implementation begins, so they are written
from the rule rather than from the code.

**Hour 8.5–9.5 — the toolchain is not the one the rest of the suite uses.**
pgTAP tests are SQL, run by `supabase test db`, and do not appear in the vitest
run. A reviewer typing `pnpm test` and seeing green has **not run the RLS
tests**. → `"test": "vitest run && supabase test db"` in `package.json`, decided
now rather than discovered at submission.

**Hours 11–12 — the manual verification list is missing its sharpest case.**
Add: *open two browser tabs in one chat, remove one member from the other tab,
and confirm the removed member's open tab stops receiving messages.* R13 §5 says
it probably will not — Realtime caches RLS evaluation for the lifetime of the
WebSocket, with no documented upper bound. This is the single most likely place
a demo contradicts a README claim in front of the person grading it.

**Tier 3 — reorder and re-scope.**

- Priority 1 (file-read tool) additionally ships R7's `externally_observable`
  flag on the `Tool` interface. ~20 min. Do this even if enforcement is
  deferred — the seam is the deliverable.
- Priority 4 (space view) drops the canvas hit-testing budget: **SVG**. R15's
  own counter-argument is correct that at a few hundred nodes SVG holds 60fps
  and gives native hit-testing, `title` tooltips and CSS styling for free. Keep
  the single long-lived `forceSimulation` plus `alphaTarget(0.3).restart()`
  toggle pattern — that part of R15 is well-sourced and renderer-independent.

**Risk register — three entries missing.**

| Risk | Likelihood | Mitigation |
|---|---|---|
| `after()` extraction cancelled by function timeout, silently | medium | `memory_extraction_failed` event in a `try/catch`; deferred `pg_cron` reconciliation sweep named as "with more time", not built |
| Realtime keeps delivering to a removed member's open socket | medium | Client force-unsubscribes on a membership-change event; README claims removal takes effect "on the next reconnect or request", not "immediately" |
| `pnpm test` green while RLS untested | high | Composed test script; stated in the README's testing section |

---

## 5. README wording: what cannot be claimed, and what can

### Prompt injection — the one that must not be overstated

The evidence is unambiguous and comes from the model vendors themselves.
*The Attacker Moves Second* (arXiv:2510.09023, OpenAI + Anthropic + DeepMind
co-authors) tested 12 published defences against **adaptive** attackers rather
than static benchmarks: defences reporting near-zero attack success rates fell
to **above 90%**, with prompting-based defences specifically at **95–99%**, and
human red-teaming reaching 100% against some. A NAACL 2025 findings paper
independently broke all eight indirect-injection defences it tested at >50% ASR.

**Do not write, anywhere in this repo:**

- "We are protected against prompt injection."
- "Our fencing / delimiting / system-prompt guardrails prevent injection."
- Anything that presents `TOOLS.untrustedContentFence` as a security control.

**Write this instead — it is structural, falsifiable, and testable:**

> Tool output — file content, search results — is untrusted data. It reaches the
> model only inside a fenced, JSON-encoded `tool_result` block carrying explicit
> provenance, and a turn that has ingested untrusted tool content cannot make a
> further externally-observable tool call outside a fixed allowlist resolved
> outside model control. The fence raises the cost of an opportunistic attack;
> it is not a security boundary and we do not claim it as one. The boundary is
> the privilege rule, because that one is enforced in code rather than in
> English.

### The other five claims that need honest hedging

**Deferred extraction.** `after()` shares the invocation's timeout and is
cancelled if the function times out; Vercel documents no durability guarantee
across instance recycling or a mid-request deploy.

> Not defensible: "memory extraction is durable / guaranteed."
> Defensible: *"Extraction runs after the response is delivered, inside the same
> invocation. If it fails, an `agent_events` row records the failure — nothing
> retries it. A durable queue is the correct answer at real scale and is
> deliberately not built here."*

**Turn idempotency (D-011).** The unique constraint prevents a duplicate
*message*. It does not prevent a *partially completed* turn from re-running.

> Not defensible: "agent turns are idempotent."
> Defensible: *"A resent message is deduplicated by a database constraint, not by
> application logic. Partial-turn recovery — model call succeeded, reply insert
> failed — is designed but unverified; there is no test that crashes mid-turn."*

D-011's status should read **"design settled, implementation unverified"**, not
closed, until `tests/agent/turn-idempotency.test.ts` exists.

**Removed members lose history (D-012).** True over HTTP under RLS. Over an open
Realtime WebSocket, RLS evaluation is cached for the connection's lifetime with
no documented eviction on membership change, and `DELETE` events bypass RLS
entirely.

> Not defensible as written: "access ends at the moment of removal."
> Defensible: *"A removed member's next request returns nothing. An already-open
> live subscription may continue to receive events until it reconnects — a
> known, bounded staleness window we did not close."*

**The surfacing rule.** The structural claim survives contact with the
literature and can stay strong. What must be added is the limit:

> *"The rule governs which items reach the model. It does not prevent a user
> inferring an unauthorised fact by combining two individually authorised
> answers — the aggregation problem, which the RAG-security literature names as
> open and which no system we reviewed claims to solve."*

**Industry comparison.** Do not write "this is how Glean does it." Every source
in R16 is vendor marketing or a secondary summary, and every incident cited
(Copilot oversharing, Slack AI) comes from systems with orders of magnitude more
surface area. If it comes up in the interview, the honest framing is: *these
incidents describe the shape of the failure this design defends against; they
are not evidence that this implementation would have avoided them.*

---

## 6. Traps the current design walks straight into

1. **The fence is already in the config, and it reads like a control.**
   `TOOLS.untrustedContentFence` sits in `config/agent.ts` with a comment
   asserting "a tool result can never itself authorise a further privileged tool
   call" — a claim currently enforced by **nothing**. An XML delimiter is
   precisely the prompting-based defence measured at 95–99% bypass. The comment
   is a promise the code does not keep; either the orchestrator enforces it or
   the comment is rewritten.

2. **Empty-audience vacuous truth is a live fail-open.** The containment
   predicate is "every active member of C2 was in the snapshot." In both SQL
   (`NOT EXISTS`) and JS (`Array.every`), that is **true** when C2 has no active
   members. A fully vacated chat therefore passes containment for *every* memory
   item in the system. R12 flags the missing test; the bug it would catch is the
   exact leak the project exists to prevent. **Fail closed explicitly: zero
   active members returns zero items, not all of them.**

3. **ARCHITECTURE §3 implies atomicity that `supabase-js` cannot deliver.** The
   pipeline is drawn as one flow; it is a sequence of independent PostgREST
   transactions. Anyone implementing it literally gets a check-then-insert race
   on `client_message_id` and a `chat_members` read that can shift between the
   membership resolution and the memory filter. The RPC in §3 is the fix.

4. **`llm_calls` written after the call double-bills every retry.** The current
   schema has `latency_ms` and no status, which forces write-after-return. A
   crash between "Anthropic charged us" and "row inserted" leaves no trace, and
   the retry pays again. A money bug, not a tidiness bug.

5. **Two retry layers compound silently.** SDK default 2× plus
   `maxRetries: 1` is up to three attempts with backoff, against
   `judge.timeoutMs: 20_000`, on the gate's hot path — while the config file
   claims one retry. The gate then hits `onJudgeFailure: 'stay_silent'` and the
   agent goes quiet for a reason nobody can find in the logs.

6. **`research.timeoutMs` (180s) is three times `maxWallClockMs` (60s), and
   `reason.timeoutMs` (300s) is the entire Vercel Hobby ceiling.** A research
   turn cannot complete, and when it fails it takes the `after()` extraction
   with it — a timed-out function cancels its own deferred work.

7. **Memory-write planting is a delayed-fuse leak unique to this design.**
   `extract.ts` runs on the model's own reply. An injected instruction that makes
   the model *assert a false fact about a user* plants that lie into
   `memory_items`, where it then surfaces — correctly authorised — in every
   future chat the audience rule permits. The generic injection literature does
   not cover this because generic systems do not persist. Mitigation: an item
   extracted from a turn that touched untrusted tool content is forced to
   `source_type: 'inferred'` regardless of phrasing, and below
   `confidenceThreshold`, so it lands as `candidate` and is never retrieved.

8. **`middleware.ts` as an auth boundary.** CVE-2025-29927 (CVSS 9.1) let a
   spoofed `x-middleware-subrequest` header skip every middleware check on
   self-hosted Next. Vercel patched that instance; the lesson is the project's
   own thesis #2. The proxy is a redirect for UX. RLS is the boundary. Name the
   file `proxy.ts` so nobody mistakes it for the guard.

9. **`getSession()` on the server.** Supabase now explicitly says not to trust it
   server-side — it does not revalidate. `ScopedAgentContext` resolves the actor
   for an authorisation decision; if that resolution ever reads `getSession()`,
   the two-axis check runs on a claim Supabase itself would reject. Use
   `getClaims()`.

10. **The green-checkmark illusion.** `pnpm test` is `vitest run`. The RLS tests
    — the ones defending thesis #2 — run under a different command in a
    different language. Compose the script, or the most important tests in the
    repo are the ones nobody runs.

11. **D-019 is claimed twice.** R10 proposes "D-019 — event/trace ID hierarchy"
    and R15 proposes "D-019 — space view renders on canvas." Assign
    **D-019 = trace/ID hierarchy** (it gates schema) and **D-020 = space view
    renderer** (resolved to SVG, per §1). A decision log with a duplicate number
    is worse than one with a gap.

12. **Reports that are thin — do not repeat their conclusions as settled.**
    - **R16** is Band C ammunition built on four sources, three of them vendor
      marketing or secondary summaries. Its own "no published name found" for
      the snapshot rule is an absence-of-evidence result. Do not cite it.
    - **R15** recommends canvas on benchmark crossovers (1,000–2,000 elements)
      that sit *above* Quorum's stated scale, and admits the node count was never
      established. Its recommendation does not follow from its findings —
      overridden here.
    - **R14** flags that it never confirmed PostgREST's default isolation level
      from PostgREST's own docs; it rests on the absence of a contrary
      statement. Verify before that becomes a README sentence.
    - **R8 finding 5** never checked Anthropic's API reference for a server-side
      idempotency mechanism — a web search that found nothing is not a
      confirmation that nothing exists. Verify before claiming "idempotency is
      entirely our responsibility."
    - **R10** proposes a `tool_calls` table and then argues convincingly against
      it; the counter-argument is adopted, the recommendation is not.
    - **R7's** own recommendation hedges to "ship the flag, defer enforcement."
      Shipping an unenforced flag while the README claims a privilege rule is the
      worst of both. Either enforce it in `orchestrator.ts` or drop the claim
      from the README — not one without the other.
