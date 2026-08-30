# Decision log

Kept live, from hour zero. The README's architecture and tradeoffs sections are
written *from* this file — reconstructing reasoning at the end produces visibly
worse writing than capturing it as it happens.

Format per entry: **Context → Decision → Why → Status → Revisit if**.
`OPEN` decisions must not be silently resolved in code.

---

## Index

| # | Decision | Status |
|---|---|---|
| D-001 | Next.js + Supabase + Vercel, one language end to end | settled |
| D-002 | One `chats` table with a `type` discriminator | settled |
| D-003 | Authorisation is two independent axes | settled |
| D-004 | Embedding provider | **OPEN** — blocks memory ranking |
| D-005 | Memory surfacing rule: audience containment AND clearance floor | settled |
| D-006 | Audience is a learn-time snapshot | settled |
| D-007 | Graph memory (`memory_nodes`/`memory_edges`) | **OPEN** — provisionally cut |
| D-008 | Hybrid response gate, biased toward silence | settled |
| D-009 | Authorisation consistency mid-turn (TOCTOU) | **OPEN** |
| D-010 | Model selection by purpose, not by model id | settled |
| D-011 | Agent-turn idempotency | **OPEN** |
| D-012 | Removed members lose access to history | settled (assumption) |
| D-013 | Memory extraction is deferred, never inline | settled |
| D-014 | Conflict resolution is deterministic, never delegated to the model | settled |
| D-015 | Project name: Quorum | settled |
| D-016 | Three build tiers over 12 hours | settled |
| D-017 | List UI ships first; bubble canvas is scheduled last | settled |
| D-018 | RLS policy in the same migration that creates the table | settled |

---

## D-001 — Stack

**Context.** Free-tier constraints, a ~12 hour budget, and a hard requirement to
deploy something a reviewer can open.

**Decision.** Next.js App Router (TypeScript) on Vercel; Supabase for Postgres,
Google auth, storage, and RLS.

**Why.** One codebase, one language, one deployment surface. Supabase gives
row-level security as a first-class primitive, which matters because
authorisation is the graded axis — RLS lets the *database* be the enforcement
point rather than a hand-audited set of endpoints. Both free at this scale.

**Revisit if.** Never, within this timebox. Changing stack mid-build is how a
take-home fails.

---

## D-002 — One `chats` table

**Context.** DMs, group chats, and direct agent conversations behave differently
but share almost all their data.

**Decision.** A single `chats` table with `type ∈ {dm, group, agent}`. DM = two
humans, no administration. Group = 2+, with admins/invites/requests/removal.
Agent = one human, different gate behaviour.

**Why.** Separate tables would triple the RLS surface for no modelling gain, and
RLS surface is exactly what must stay auditable.

---

## D-003 — Two authorisation axes

**Decision.** Membership (`chat_members.status = 'member'`) **and** clearance
(user's grants vs `chats.required_clearance_id`). Both must pass, on every read.

**Why.** The brief only requires membership. Clearance is the addition that
makes the memory rule complete: the same people can share a level-3 and a
level-0 chat, so containment alone cannot distinguish them. Clearance is also
the more realistic model for a legal product, where the relevant question is
often *in what capacity* someone is present.

---

## D-004 — Embedding provider — **OPEN**

**Context.** The retrieval design ranks by semantic similarity, which needs
embeddings. **Anthropic does not ship an embeddings API.** The spec assumed a
`vector` column and an ivfflat index without naming a provider — a genuine hole.

**Options.**
1. A third-party embedding API (extra key, extra vendor, extra latency).
2. A local/edge model (no key, but bundle size and cold starts on serverless).
3. Postgres full-text search + recency, no vectors at all.

**Leaning.** Option 3 as the tier-1 fallback with option 1 behind
`lib/memory/embed.ts` as an interface, so ranking can be upgraded without
touching the filter. **The filter does not depend on this** — authorisation is
set containment and an integer comparison, and stays correct with any ranker.
That containment is what makes this decision deferrable rather than blocking.

**Status.** OPEN. → research **R3**.

---

## D-005 — The memory surfacing rule

**Decision.** An item learned in C1 surfaces in C2 only if every active member
of C2 was in the item's audience snapshot **and** C2's clearance level >= the
item's. Evaluated in SQL, before ranking.

**Why.** The requirement as written invites a leak (see README). Both conditions
are needed: containment alone permits an exec-channel fact to appear in a
general channel with the same members. The rule fails closed, is cheap, and is
testable — and because filtering happens before the model call, the model never
receives out-of-scope memory and so cannot leak it.

**Revisit if.** A product requirement genuinely needs visibility to widen. That
would be an explicit act by the subject, not an automatic broadening.

---

## D-006 — Audience is a snapshot

**Decision.** `memory_audience` records the active member set at the instant the
item was learned. Containment is evaluated against it, never against current
membership.

**Why.** Membership changes. Someone who joined a group in March was not in the
room in January, and evaluating against *current* membership would either leak
to them or spuriously exclude the item everywhere.

---

## D-007 — Graph memory — **OPEN, provisionally cut**

**Context.** The original design had `memory_nodes` and `memory_edges` giving
graph semantics inside Postgres, with per-hop authorisation filtering.

**Decision (provisional).** **Cut.** Ship a purely relational memory model.

**Why.** The brief does not require a knowledge graph. The expansion invitation
was "expand if you want", which is not "build everything possible". The risk is
that the submission reads as *look how much architecture I can build* rather
than *look how well I prioritised* — and the graph would most likely eat the
memory-isolation tests and the README, which are the actually-graded artifacts.
The stronger answer is: *"I considered a graph representation and deliberately
kept the first version relational, because the core requirement is scoped
retrieval, not graph traversal. I would introduce graph semantics once a
concrete product query justified the complexity."*

**Status.** OPEN by explicit instruction — the cut is only confirmed if research
**R4** substantiates it, or reopened if R4 produces a concrete product query
that relational retrieval answers badly.

---

## D-008 — Hybrid response gate

**Decision.** Deterministic chain of six rules first, first match wins; a model
judge only for what falls through. Judge biased toward silence; judge failure
resolves to silence.

**Why.** "Let the LLM decide whether to respond" is unreproducible and untestable
for the cases that matter most (never answer yourself; stay out of a DM).
Deterministic rules make those cases *provable*. The judge exists for genuine
ambiguity only. Failure modes are asymmetric: an over-quiet agent is a mild
annoyance, an over-eager one is unusable.

---

## D-009 — Authorisation consistency mid-turn — **OPEN**

**Context.** An agent turn is not instantaneous. If an admin removes a member at
t+2s and memory retrieval runs at t+3s, what should the agent see? Classic
time-of-check/time-of-use.

**Why it matters.** Without a defined answer this is decided by accident, and
"what happens if membership changes during a turn?" is an obvious interview
question against this design.

**Candidate answers.** (a) Snapshot at turn start and accept the staleness
window; (b) re-check before each privileged read; (c) run the turn in a single
transaction at a defined isolation level.

**Status.** OPEN. → research **R2**.

---

## D-010 — Model selection by purpose

**Decision.** Callers pass a `CallPurpose` (`gate_judge`, `chat_response`, …).
Purpose → tier → model + effort + limits, all in `config/models.ts`.

**Why.** The supplied API key is short-lived and rate-limited, so a dead or
throttled model must be a one-file change. It also makes the cost dashboard
meaningful: `purpose` is a closed set, so it works as a dimension, whereas
free-text purposes would make the dashboard useless within a day.

**Note.** On the Claude 5 family, `thinking.budget_tokens` is removed and
rejected; depth is `output_config.effort`. The config encodes this per model
because Haiku 4.5 still uses the older shape and rejects `effort`.

---

## D-011 — Agent-turn idempotency — **OPEN**

**Context.** A request times out, the client retries, the same message is
processed twice, the agent answers twice. Or a background retry re-fires
extraction and writes duplicate memory.

**Leaning.** Design for **at-least-once** delivery and make the turn idempotent,
rather than chasing exactly-once. Concretely: a `client_message_id` supplied by
the client with a unique constraint on `(chat_id, client_message_id)`, and a
`turn_id` that makes a replayed turn recognisable.

**Status.** OPEN. → research **R8**.

---

## D-012 — Removed members lose history

**Decision.** Access to a chat and all its history ends at the moment of
removal.

**Why.** The Slack-style alternative (retain previously visible history) is
equally defensible. The stricter reading was chosen because this is a legal-
adjacent product and because it is the simpler thing to prove with a test.
Recorded as an assumption in the README rather than presented as obvious.

---

## D-013 — Deferred memory extraction

**Decision.** Extraction runs after the response is delivered, never inline.

**Why.** Keeps the user-visible turn fast and avoids the serverless timeout
cliff. *How* "after" is implemented (`waitUntil` vs a real queue) is open — see
R9 — but the ordering is settled regardless.

---

## D-014 — Deterministic conflict resolution

**Decision.** Ordered rules: stated-by-subject outranks inferred; within the
same source type, newer outranks older; a genuine tie keeps the newer, marks the
older `superseded`, and writes a `memory_conflict` event.

**Why.** Asking the model which of two conflicting facts it prefers is the
failure mode to avoid — it is unreproducible, untestable, and silently wrong.
Writing the conflict as an event makes the resolution visible in the internal
view rather than invisible.

---

## D-015 — Name

**Decision.** Quorum.

**Why.** The minimum set of people who must be present for something to count —
which is both the "minimum two users" requirement and, more importantly, the
audience-snapshot rule. Legal register suits the client.

---

## D-016 — Three build tiers over 12 hours

**Decision.** Tier 1 submittable MVP → tier 2 depth on memory/agent/authorisation
→ tier 3 tools and polish. Detail in [BUILD-PLAN.md](BUILD-PLAN.md).

**Why.** Running out of time must degrade the demo, not the substance. Each tier
ends at a state that could be submitted.

---

## D-017 — List UI first, canvas last

**Decision.** A conventional list view ships in tier 1 and remains the fallback.
The force-directed space view is the last thing built.

**Why.** It is the most visually impressive piece and the least graded. Building
it early would trade graded substance for ungraded polish.

---

## D-018 — RLS in the creating migration

**Decision.** Every table's RLS policy is written in the same migration that
creates the table. Never a follow-up.

**Why.** A table that exists without a policy for even one deploy is fully
readable via the publishable key, which is in the browser bundle. Coupling them
in one file removes the window entirely.
