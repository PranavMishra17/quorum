# R8 — Idempotency and duplicate agent turns

**Band:** B · **Closes:** D-011 · **Status:** complete

## Question

A request to send a message can be retried by the client (network timeout,
double-tap on send) or redelivered by the platform (serverless retry,
deferred-work redelivery). Naively, that means the same user message gets
persisted twice, the model gets called twice and billed twice, or the agent
posts two replies to one human message. Quorum's turn pipeline
(`docs/ARCHITECTURE.md` §3) writes across four+ tables plus one external API
call (`llm_calls`, `messages`, `agent_events`, memory tables, the Anthropic
call itself) in one logical turn, none of it behind a distributed transaction.
The question is what exactly is idempotent, on what key, for how long, and
what a partial failure inside that pipeline is defined to do — since D-011 is
currently an unresolved OPEN decision blocking the message-send and
agent-turn-pipeline files.

## Findings

**1. Idempotency keys: client- vs server-generated, and the constraint location.**
Stripe's idempotency-key design is the reference implementation most API
idempotency schemes copy: the *client* generates the key (Stripe suggests a v4
UUID) and sends it as a request header; Stripe stores the resulting status
code and body keyed by it, and any retry with the same key returns the saved
result without re-executing the operation (Stripe, "Idempotent requests",
https://docs.stripe.com/api/idempotent_requests). This has to be
client-generated: a server-generated key defeats the purpose, because the
whole failure mode being defended against is "the client doesn't know whether
its request landed" — a server-issued key requires a prior round trip that
could itself fail. The uniqueness has to be enforced as a real constraint, not
an application-level check-then-insert, because concurrent retries (e.g. a
user's request timing out and the client firing a second attempt while the
first is still in flight) create a race that only a database-level
UNIQUE constraint (or unique index) closes atomically — this is exactly what
Postgres's `INSERT ... ON CONFLICT` is for: it "guarantees an atomic INSERT or
UPDATE outcome... even under high concurrency" (PostgreSQL 17 docs, "INSERT —
ON CONFLICT Clause", https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT).
Quorum already made this call for the message layer: `docs/ARCHITECTURE.md`
line 97 has `messages (chat_id, client_message_id) UNIQUE`, and D-011's
leaning text already names `client_message_id` supplied by the client. This
finding confirms that leaning is the industry-standard shape, not just a
plausible one.

**2. At-least-once + idempotent turn, confirmed.** Exactly-once delivery is a
proven impossibility in asynchronous distributed systems (rooted in the Two
Generals Problem and formalized by the FLP result), because a producer that
doesn't receive an acknowledgment cannot distinguish "processed, ack lost"
from "never arrived," and must either risk a duplicate or risk a loss
(Fischer, Lynch, Patterson, "Impossibility of Distributed Consensus with One
Faulty Process", 1985 — summarized in
https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/, a widely-cited
distillation of the primary result). The practical resolution the industry
converged on — Stripe, Shopify webhooks, and cloud queue systems alike — is
at-least-once delivery paired with an idempotent consumer (dedup on a key,
upsert semantics, or conditional writes). Vercel's own Queues product
documents this explicitly: "Queues defaults to at-least-once delivery... The
tax is idempotency, and it is not optional" (Vercel, "Queues concepts",
https://vercel.com/docs/queues/concepts). What makes *Quorum's* turn
idempotent, specifically: the operation that must be safe to retry is not "run
the whole pipeline again" but "resolve `client_message_id` to a canonical
`turn_id`, and treat every downstream write in that turn as owned by that
`turn_id`, using an insert-or-return-existing pattern rather than re-running
already-completed side effects."

**3. Partial completion — the one sub-question with no clean industry answer.**
This is squarely Quorum's problem, not a solved pattern anyone hands you.
Consider the sequence `docs/ARCHITECTURE.md` §3 lays out: message persisted →
gate evaluated → memory retrieved → model called (billed) → agent reply
insert. If the agent-reply insert fails after the model call succeeded, a
naive retry replays the model call and pays for it twice. There are two
disjoint strategies, and the report does not find a single authority-backed
"correct" one — this is a genuine design choice, not a researched fact:
   - **Outbox-style durability**: persist the model's response (and the fact
     that the call happened) in the same transaction/step where the
     `llm_calls` row is written, *before* attempting the reply insert, so a
     retry can detect "the call already happened, the row exists, only the
     reply insert needs to happen" and skip the call. This is the same shape
     as the transactional outbox pattern used to avoid dual-write problems
     between a database and a message broker: write the fact of the
     completed step durably in the same store, then let a separate step
     consume it (microservices.io, "Pattern: Transactional outbox",
     https://microservices.io/patterns/data/transactional-outbox.html).
   - **Turn-state machine**: model `turn_id` with an explicit status column
     (`pending → model_called → replied → done`, or similar) so a retry can
     resume from the last completed step rather than restarting the pipeline
     or blindly re-running everything.
   Both require the same primitive: the `llm_calls` row must be written
   *before or atomically with* determining "should I call the model," so a
   retry can check it first. Neither Stripe's docs nor the outbox pattern
   description answers the multi-table, single-Postgres-instance case
   directly — those are patterns for cross-service/cross-broker atomicity,
   and Quorum's four tables are all in the same Postgres database, which is
   actually a simpler case (a single multi-statement transaction can cover
   `messages` + `agent_events`, though the external Anthropic call cannot be
   inside that transaction since it's a network call to a different system).

**4. Deduplication window.** Stripe prunes idempotency keys after a minimum of
24 hours and treats a reused key past that point as a new request (Stripe,
op. cit.). This number is Stripe-specific (chosen for their retry/timeout
characteristics), not a physical law — no primary source establishes a
universal "correct" window. For Quorum, `client_message_id` uniqueness is
better modeled as **permanent** (a UNIQUE constraint with no expiry) rather
than a TTL'd key: message IDs are cheap to keep forever in a chat app (they're
just UUIDs on a `messages` row that persists anyway), and there is no
product reason to ever let a resend with the same `client_message_id`
re-execute — unlike Stripe, where a stale key eventually needs to be freed
for reuse in an unrelated high-volume payments system. This is a
recommendation, not a sourced fact.

**5. Do LLM calls need their own idempotency?** The public Anthropic Messages
API does not expose an idempotency-key header — a targeted search
(WebSearch, "Anthropic API idempotency key header") surfaced only
authentication headers (`x-api-key`, `anthropic-version`) and no idempotency
mechanism, and this could not be confirmed against Anthropic's own API
reference in this pass (fetching `platform.claude.com/docs` was not attempted
directly; this is a gap — see Sources note). Assuming no server-side
idempotency exists on the model call itself, idempotency has to be enforced
**on Quorum's side, before the call is made**: check whether a `llm_calls`
row already exists for this `turn_id` + step before issuing the request, not
just before persisting the response. This is a real cost risk finding: point
3's ordering question (write-then-call vs call-then-write) directly
determines whether a crash between "call succeeded" and "row written" causes
a double-bill on retry.

**6. Distributed locks vs unique constraints vs outbox — proportionate choice.**
For Quorum's scale (a take-home-sized single-Postgres-instance app, not a
multi-service system), a distributed lock (Redis, Postgres advisory lock) is
over-engineering: it adds an external coordination dependency and a lock-
expiry failure mode to solve a problem a UNIQUE constraint already solves
atomically and for free, per finding 1's Postgres `ON CONFLICT` citation. A
full transactional outbox (separate outbox table + relay process) is also
disproportionate for in-process work — it exists to solve the dual-write
problem between a database and an *external message broker*
(microservices.io, op. cit.), and Quorum has no broker; `agent_events` and
`llm_calls` are read directly by the internal view, not relayed anywhere.
The proportionate mechanism is: (a) a UNIQUE constraint on
`(chat_id, client_message_id)` for message-level dedup (already decided per
finding 1), and (b) a `turn_id`-keyed status/existence check before each
side-effecting step (model call, reply insert) — a poor man's outbox using
existing tables rather than a new pattern. This matches
`docs/ARCHITECTURE.md`'s own framing that `turn_id` "threads through
`agent_events` and `llm_calls`" as the correlation id.

**7. Interaction with optimistic UI on send.** This sub-question is not
addressed by any of the sources found in this pass — it is a client-side UX
question (does the client show the message immediately, and how does it
reconcile if the server-assigned `turn_id`/message differs) rather than a
backend idempotency question, and no primary source in this research track
speaks to it. Flagging as **unresolved**: the client needs to generate
`client_message_id` locally (so it can render optimistically before any
server round trip, consistent with finding 1's requirement that the key be
client-generated), and reconcile its optimistic local row with the persisted
row once the server responds — using `client_message_id` as the join key.
This is an inference from findings 1 and 2, not something a cited source
states directly.

## Application to Quorum

- **`supabase/migrations/0004_messages.sql`** — already specified in
  `docs/ARCHITECTURE.md` line 97 as
  `messages (chat_id, client_message_id) UNIQUE`. This report confirms that
  design and recommends **no TTL/expiry** on this uniqueness (finding 4):
  treat it as a permanent constraint, not a pruned key store.
- **`supabase/migrations/0005_agent_events.sql`** (`agent_events`,
  `llm_calls`) — needs `turn_id` to be queryable *before* the model call is
  issued, so the orchestrator can check "does an `llm_calls` row already
  exist for this `turn_id`" prior to spending money on a retry (finding 5).
  This likely means a `turn_id` index on `llm_calls`, and writing the
  `llm_calls` row (or at minimum a `model_call_started` `agent_events` row)
  *before* the network call fires, not after it returns — so a crash mid-call
  leaves a detectable "in-flight" marker rather than silence.
- **`lib/agent/orchestrator.ts`** (owns `turn_id` per
  `docs/ARCHITECTURE.md` line 176) — is the place the partial-failure
  behaviour from finding 3 must live: on receiving a `client_message_id` that
  already has a `turn_id`, resume from the last completed step recorded in
  `agent_events` rather than restarting the pipeline. This is currently
  undocumented behaviour in the pipeline diagram at
  `docs/ARCHITECTURE.md` §3 — the diagram shows only the happy path
  ("idempotency check on client_message_id → duplicate? return existing
  turn"), which handles duplicate *messages* but not a *partially completed*
  turn (a duplicate request arriving after the message was persisted but
  before the reply was). That gap is exactly what D-011 flags and what this
  report cannot fully close (see Recommendation).
- **`app/api/chats/[chatId]/messages/route.ts`** — the idempotency check
  point per `docs/ARCHITECTURE.md` line 225 ("Send message; idempotent on
  `client_message_id`"). Confirmed as the right layer for finding 1's
  client-generated-key pattern.
- **Client-side (not yet a named file — chat surface under `app/(app)/`)** —
  needs to generate `client_message_id` (e.g. UUID) at compose time, before
  any network call, per finding 7.
- **`config/`** — if a dedup window is ever added (this report recommends
  against one, per finding 4), it belongs in `config/agent.ts` alongside
  other thresholds, never inline.

## Recommendation

**Closes D-011.** Adopt the leaning already stated in `docs/DECISIONS.md`:
**at-least-once delivery with an idempotent turn**, keyed by a
client-generated `client_message_id` enforced with a UNIQUE constraint on
`(chat_id, client_message_id)` (already specified), plus a `turn_id` that
threads through `agent_events` and `llm_calls` and is checked *before* the
model call to avoid double-billing. No dedup TTL — the constraint is
permanent. No distributed lock, no transactional outbox — a UNIQUE constraint
plus a `turn_id`-gated resume check is proportionate at this scale.

**The strongest argument against this option:** it does not actually solve
partial-turn recovery — it only prevents the *easy* case (a full duplicate
message). The hard case (finding 3: model call succeeded, reply insert
failed) still requires the orchestrator to correctly detect "which step did I
last complete" and resume rather than restart, and that logic is unproven —
no automated test in `tests/` currently exercises a crash-mid-turn scenario,
and the pipeline diagram in `docs/ARCHITECTURE.md` doesn't show a resume
path. A reviewer could reasonably say D-011 isn't actually closed by "use a
unique constraint" — that's necessary but not sufficient, and the harder
half of the problem (the state-machine resume logic in
`lib/agent/orchestrator.ts`) is still open engineering work, not a settled
research question. This report's evidence supports the *shape* of the
solution (client key + unique constraint + at-least-once) but does not
supply a tested resume implementation.

**What would settle the open half:** an integration test in
`tests/agent/gate.test.ts` or a new `tests/agent/turn-idempotency.test.ts`
that (a) persists a message, (b) simulates the reply-insert step failing
after the model call succeeded, (c) retries the same `client_message_id`, and
(d) asserts exactly one `llm_calls` row exists for that `turn_id` and exactly
one agent reply is posted. Until that test exists and passes, D-011 should
be considered "design settled, implementation unverified," not fully closed.

## Sources

- Stripe, "Idempotent requests" — https://docs.stripe.com/api/idempotent_requests (official API docs; primary source for the client-generated-key pattern, 24-hour pruning window, and same-key-different-body error behaviour)
- PostgreSQL 17 Documentation, "INSERT — ON CONFLICT Clause" — https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT (official docs; primary source for atomicity guarantee of `ON CONFLICT DO UPDATE`/`DO NOTHING`)
- Chris Richardson, "Pattern: Transactional outbox" — https://microservices.io/patterns/data/transactional-outbox.html (canonical pattern reference; used for the outbox-vs-proportionate-solution argument in findings 3 and 6)
- Vercel, "Queues concepts" — https://vercel.com/docs/queues/concepts (official docs; primary source for Vercel's own at-least-once delivery stance and "idempotency is not optional" framing)
- Vercel, "Functions API Reference" (`waitUntil`, cancellation, SIGTERM behaviour) — https://vercel.com/docs/functions/functions-api-reference (official docs; relevant to R9 but consulted here to confirm that a Vercel function has no built-in duplicate-suppression — idempotency is entirely the application's responsibility)
- Fischer, Lynch, Patterson impossibility result, distilled in Tyler Treat, "You Cannot Have Exactly-Once Delivery" — https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/ (secondary distillation of a primary theoretical result; used only for the at-least-once-is-the-only-honest-option argument in finding 2, not as a load-bearing claim on its own — the underlying FLP 1985 result is the actual authority)

**Uncertainty flagged:** Finding 5 (whether the Anthropic Messages API offers
any server-side idempotency mechanism) was not confirmed against Anthropic's
own API reference directly in this pass — only a web search was run, which
did not surface one. This should be verified against
https://platform.claude.com/docs/en/api before the assumption "idempotency is
entirely Quorum's responsibility for the model call" is stated as fact in the
README.
