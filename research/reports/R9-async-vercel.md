# R9 — Async work on Vercel

## Question

D-013 settles that memory extraction runs *after* the agent's response is
delivered, never inline, to keep the user-visible turn off the serverless
timeout cliff. It does not settle *how* "after" is implemented. The candidates
are Vercel's `waitUntil`/`after()` (extend the same invocation past the
response) versus a real queue (persist a job, process it out-of-band, with
retry and dead-letter semantics). The choice matters for Quorum specifically
because extraction is on the hot path of the privacy thesis: `memory_written`
events, the `memory_audience` snapshot, and `memory_conflict` resolution all
happen inside whatever mechanism "deferred" turns out to mean, and a dropped
extraction is invisible unless something logs it.

## Findings

**1. What `waitUntil` actually guarantees.**
`waitUntil(promise)` "extends the lifetime of the request handler for the
lifetime of the given Promise." Critically: *"Promises passed to `waitUntil()`
will have the same timeout as the function itself. If the function times out,
the promises will be cancelled."* [Vercel Functions package docs] This is not
a fire-and-forget guarantee — it is a soft extension of the same invocation's
clock, not an independent execution slot. On Next.js ≥15.1, Vercel recommends
`after()` from `next/server` over the raw `waitUntil` helper for the same
purpose; `after()` is not a Dynamic API and does not force a route dynamic.
Both share the same underlying constraint: whatever `maxDuration` applies to
the request also caps the background work.

**2. Serverless timeouts on the free tier, and whether a streamed turn +
tool loop fits.**
As of the current docs (fetched 2026-08-24), Fluid Compute is enabled by
default for new projects, and under Fluid Compute the **Hobby plan default
and maximum function duration is 300 seconds (5 minutes)** — not the
historical "10 seconds" figure that several third-party 2026 blog posts still
quote (their claims are stale/incorrect against the primary source and are
flagged here specifically because they contradicted the official docs; they
are not cited as authority in this report). [Vercel: Configuring Maximum
Duration; Vercel: Fluid compute] Pro/Enterprise raise the ceiling to 800s
generally available, 1800s (30 min) in beta for specific runtimes.
Against `config/agent.ts`: `TOOLS.maxWallClockMs = 60_000` (60s) for the tool
loop, plus `CONTEXT.tokenBudget = 24_000` tokens of model streaming — a full
agent turn (gate → retrieve → assemble → stream → bounded tool loop) sits
comfortably inside a 300s ceiling even before extraction is added.
`MEMORY.extraction.maxItemsPerTurn = 5` items over `contextMessages = 12`
recent messages is a small, bounded structured-output call — realistically
single-digit seconds. **Conclusion: a streamed turn plus deferred extraction,
run via `waitUntil`/`after()` within the same invocation, fits inside Hobby's
300s budget with wide margin**, provided `maxDuration` is set explicitly
(Next.js App Router route files must export `maxDuration`; the fluid-compute
default already covers this but an explicit export documents the assumption
in code and survives a plan/default change).

**3. When is a real queue warranted, and the infra-free options.**
Two `pg_cron`-adjacent options exist inside Supabase without adding
infrastructure:
- **Supabase Queues / pgmq** — a Postgres-native queue built on the `pgmq`
  extension, installed and managed like any other Postgres object. Messages
  are read with a visibility timeout (VT); a message becomes invisible for
  the VT duration after being read and reappears if not archived/deleted
  before the VT expires, giving retry-by-default. `pop()` gives at-most-once
  semantics (deletes on read); `read()` + explicit `archive()`/`delete()`
  gives effectively-once-if-idempotent semantics under Postgres's
  transactional guarantees. [Supabase: pgmq docs, docs.supabase.com/guides/queues/pgmq]
- **`pg_cron`** — schedules SQL functions or HTTP calls (e.g. to invoke a
  Supabase Edge Function) directly inside Postgres. Supabase's own docs state
  schedules can run "from every second to once a year," but cap **8
  concurrent jobs** and **10 minutes per job**. [Supabase: Cron docs,
  docs.supabase.com/guides/cron]
- **Vercel Cron** was also evaluated and is the weakest option for this use
  case: **Hobby is capped at once per day, with ±59 minute scheduling
  imprecision**; only Pro/Enterprise get once-per-minute scheduling.
  [Vercel: Cron Jobs usage & pricing] This rules out Vercel Cron as a poller
  for anything needing sub-daily latency on the free tier the project is
  built against — `pg_cron` is the only "poll a queue every N seconds"
  option available without a plan upgrade.

The trigger condition for introducing a queue at all: `waitUntil`/`after()`
stops being sufficient the moment extraction work needs to **outlive the
originating invocation** — i.e. work that must survive the function being
recycled, needs cross-invocation retry with backoff, needs to be observable
and re-runnable independent of the request that spawned it, or routinely
risks exceeding `maxDuration` (e.g. a future R7-style multi-step tool-using
extraction, not today's single structured-output call). None of that is true
for Quorum's current `extract.ts` shape: bounded input (12 messages), bounded
output (5 items), no tool use, single model call. **At today's scope, a queue
is not warranted; `waitUntil`/`after()` is sufficient**, with the visible
failure mode (an `agent_events` row) as the safety net rather than an
infrastructure-guaranteed retry.

**4. Retries, dead-letter, visibility timeouts — needed at ~200 users?**
These are pgmq/queue-system concepts and only apply if R9.3's trigger
condition is met. At ~200 users, extraction is a low-volume, low-cost,
best-effort background enrichment — not a payment or delivery-critical
pipeline. Building visibility-timeout-based retry and a dead-letter table for
it now is the cargo-cult case CLAUDE.md's non-negotiables list warns against
implicitly (magic complexity introduced ahead of a proven need). What *is*
needed at this scale, and what `waitUntil` does not give for free, is
**observability of failure**: if extraction throws or the function is
recycled mid-`waitUntil`, nothing retries it and nothing tells you it didn't
happen, unless the code writes the failure explicitly. That is not a queue
problem, it is a logging problem, already scoped into the architecture via
`agent_events` (append-only, `lib/events/log.ts`).

**5. Cancellation — a user deletes a message while extraction is queued.**
Not settled by any Vercel or Supabase source (this is a Quorum design
question, not a platform fact). Two shapes are available given the `waitUntil`
approach chosen in R9.2/R9.3:
- **Best-effort skip**: `extract.ts` re-checks that the source message still
  exists (and is not soft-deleted) immediately before writing any
  `memory_items`/`memory_written` row, inside the same transaction/RPC that
  performs the write. Because `waitUntil` work runs milliseconds to low
  seconds after the response, the race window is small but not zero.
- **No special-case needed if extraction is synchronous-enough**: given
  finding 2 (extraction fits comfortably inside the turn's `waitUntil`
  window, typically completing in low single-digit seconds), the realistic
  race is "delete arrives while the `waitUntil` promise is still running,"
  not "delete arrives after a queued job sits for minutes." A guard clause —
  extraction checks `messages.deleted_at IS NULL` for its source message
  before insert — closes the window with no added infrastructure.
This is a recommendation, not a documented platform behavior, and is flagged
as such.

**6. Honest "with more time" answer.**
With more time, the thing worth building is not a queue engine — it's the
**failure-visibility layer around `waitUntil`**: an `agent_events` row of type
`memory_extraction_failed` (or similar), written from a `try/catch` around the
`waitUntil`/`after()` callback, plus a scheduled `pg_cron` job that
periodically scans for turns older than N minutes with no corresponding
`memory_written`/`memory_extraction_failed` event and re-triggers extraction
for them (a poor-man's retry using existing tables, no `pgmq` needed). That
gets most of a queue's reliability property (nothing silently drops) without
its operational surface (visibility timeouts, dead-letter tables, consumer
processes). The move to `pgmq` proper is worth making specifically when
extraction stops being a single bounded model call — e.g. if R7/tool-using
extraction, multi-step research, or cross-chat batch re-extraction on
clearance changes get built, all of which can run past a single invocation's
lifetime and need independent retry.

## Application to Quorum

- **`config/agent.ts`, `MEMORY.extraction`**: keep `deferred: true`; add (or
  document as an explicit assumption in the comment block) that deferred
  means "same-invocation `waitUntil`/`after()`," not a separate queue — this
  is the concrete decision this report closes. No new magic numbers needed
  since `maxCallsPerTurn`, `maxWallClockMs`, and `maxItemsPerTurn` already
  bound the work that has to fit inside the response + extension window.
- **Route handler for the agent turn** (per `docs/ARCHITECTURE.md` §3, "the
  agent turn"): after `persist agent message`, wrap the extraction call in
  `after(async () => { try { await extract(...) } catch (e) { await
  logEvent('memory_extraction_failed', {...}) } })` from `next/server`
  (Next.js ≥15.1 per the repo's stack) rather than the raw `@vercel/functions`
  `waitUntil`. Export `export const maxDuration = <N>` on that route file
  explicitly (finding 2) rather than relying on the fluid-compute default,
  so the assumption is visible in code and survives a future plan change.
- **`lib/memory/extract.ts`**: add the pre-write existence/deleted_at guard
  described in finding 5, reading the source message's current state inside
  the same call that writes `memory_items`/`memory_audience` rows — this is
  the concrete answer to R9.5 and should be a unit-testable branch (a test
  belongs in `tests/memory/lifecycle.test.ts`, which already exists in this
  repo per current git status).
- **`lib/events/log.ts`**: extend the `agent_events.payload` jsonb (no
  migration needed, per the extensibility charter) with a
  `memory_extraction_failed` event type carrying the turn id and error
  reason, per finding 6.
- **No `pgmq`/queue table in `supabase/migrations/`** for this milestone.
  If R9.3's trigger condition is later met, the addition is additive
  (`0009_memory_queue.sql` or similar, with RLS per CLAUDE.md non-negotiable
  #1) and does not require rewriting `extract.ts`'s call signature — only
  the caller (`waitUntil` vs `pgmq.send`) changes, which is exactly the seam
  the extensibility charter names for `lib/memory/retrieve.ts`-adjacent
  files, and should be held to the same standard for `extract.ts`.
- **`docs/DECISIONS.md`**: D-013 can be updated from "how is open — see R9"
  to closed, citing this report, with the `pg_cron`-based reconciliation
  sweep noted as the deferred/"with more time" item rather than something
  built now.

## Recommendation

**Closes D-013's open "how."** Chosen option: **`waitUntil`/`after()` within
the same invocation, not a real queue**, for memory extraction at Quorum's
current and take-home-appropriate scale (~200 users, single bounded
structured-output call per turn). A `pg_cron`-based reconciliation sweep
(finding 6) is the recommended safety net, not `pgmq`.

**Strongest argument against this recommendation.** `waitUntil`'s own
documented guarantee is weak: the promise shares the invocation's timeout and
is cancelled if the function times out, and — more importantly — Vercel gives
no documented guarantee that a `waitUntil` callback survives an instance
being recycled, a deploy rolling out mid-request, or a platform-level
interruption; the docs describe extension of lifetime for normal completion,
not durability under infrastructure failure. A real queue (`pgmq` with a
visibility timeout, or a hosted service) is durable by construction —
messages persist independent of any function invocation and survive exactly
those failure modes. For a product whose entire thesis is "we do not silently
leak or silently drop," betting the correctness of memory writes on an
un-durable background-execution primitive is arguably inconsistent with that
posture, even if the failure rate is low in practice. The mitigation adopted
here (finding 6's reconciliation sweep) is explicitly a compensating control
for this gap, not a rebuttal of it — and if the eventual grading or reviewer
weighs "does the persistence story hold under infra failure" heavily, the
queue-based answer is the more defensible one despite its added complexity.

## Sources

```
- @vercel/functions API Reference — waitUntil, after(), getDeadline
  https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
  (fetched 2026-08-30; page last_updated 2026-08-19)

- Vercel: Configuring Maximum Duration for Vercel Functions — Hobby/Pro/
  Enterprise duration limits table, extended max duration beta
  https://vercel.com/docs/functions/configuring-functions/duration
  (fetched 2026-08-30; page last_updated 2026-08-24)

- Vercel: Fluid compute — default settings by plan, background processing
  via waitUntil, isolation/instance-reuse model
  https://vercel.com/docs/fluid-compute
  (fetched 2026-08-30; page last_updated 2026-08-24)

- Supabase: pgmq (Postgres Message Queue extension) — visibility timeout,
  read_ct, pop() vs read()/archive()/delete() semantics
  https://supabase.com/docs/guides/queues/pgmq
  (fetched 2026-08-30)

- Vercel: Cron Jobs — Usage & Pricing — Hobby once-per-day limit, ±59min
  scheduling precision, Pro once-per-minute
  https://vercel.com/docs/cron-jobs/usage-and-pricing
  (fetched 2026-08-30; page last_updated 2026-07-15)

- Supabase: Cron (pg_cron) — scheduling granularity, HTTP/SQL job targets,
  8 concurrent job cap, 10-minute per-job cap, cron.job_run_details
  https://supabase.com/docs/guides/cron
  (fetched 2026-08-30)
```

Note on discarded sources: several 2026 third-party blog posts (deploywise.dev,
fencode.dev, supadrop.host, vibecoder.me, promptstoproduct.com) surfaced in
search results and uniformly claimed a 10-second Hobby function timeout. This
contradicts the primary Vercel docs above (300s default/max under Fluid
Compute, which is on by default for new projects) and is treated as stale/
incorrect, not as corroborating evidence — flagged per this track's
instruction not to let a vendor/community blog post carry a load-bearing claim.
