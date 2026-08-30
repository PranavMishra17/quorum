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
| D-004 | Embedding provider | **CLOSED** by R3 — no vectors in v1 |
| D-005 | Memory surfacing rule: audience containment AND clearance floor | settled |
| D-006 | Audience is a learn-time snapshot | settled |
| D-007 | Graph memory (`memory_nodes`/`memory_edges`) | **CLOSED** by R4 — cut confirmed |
| D-008 | Hybrid response gate, biased toward silence | settled |
| D-009 | Authorisation consistency mid-turn (TOCTOU) | **CLOSED** by R2 — re-read per privileged call |
| D-010 | Model selection by purpose, not by model id | settled |
| D-011 | Agent-turn idempotency | **PARTIAL** — shape closed, resume semantics OPEN |
| D-019 | Agent tool authority is chat-scoped | settled (new, from R6) |
| D-020 | Judge returns a discrete verdict, not a thresholded float | settled (new, from R5) |
| D-021 | No memory reflection/consolidation step in v1 | settled (new, from R4) |
| D-022 | Least-privilege turn scoping after untrusted content | settled (new, from R7) |
| D-023 | Clearance ladder is one dimension: sensitivity | settled |
| D-024 | `turn_id` and `request_id` both required; no traces table | settled (new, from R10) |
| D-025 | Space view renders SVG, not canvas | settled (new, from R15) |
| D-026 | Idempotency RPC runs at READ COMMITTED, against R14's advice | settled |
| D-027 | Discovery gated on clearance, not on membership | settled |
| D-028 | No separate agent-turn endpoint; the turn runs in `after()` | settled |
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

**Ruling (closed by R3).** **Option 3.** No embedding provider is wired into v1.
The rank step scores an already-authorised candidate set on `ts_rank` (lexical)
plus recency plus speaker presence. `lib/memory/embed.ts` ships as an
unimplemented interface. No ANN index in v1.

**Why.** The authorisation filter reduces the candidate set to tens of items
before ranking ever runs, so the marginal value of semantic ranking is far lower
here than the large-corpus benchmarks that motivate it. Against that: a second
vendor, a second key, a re-embedding migration path, and ~1h of the 12. **The
filter does not depend on the ranker** — authorisation is an anti-join plus an
integer comparison and stays correct under any ranking — which is exactly what
makes this deferrable rather than blocking.

**If reopened.** Voyage AI (Anthropic's own documented recommendation; 200M free
tokens). **HNSW, never ivfflat** — pgvector's `lists = rows/1000` degenerates to
1 at this scale, and Supabase's docs name HNSW the default. Carry an
`embedding_model` column beside `embedding` so a provider swap is detectable
rather than silently wrong.

**The strongest argument against.** Lexical matching finds lexemes, not meaning.
This is a legal product, and "Delaware governing law" vs "the client's
choice-of-law clause" is precisely the paraphrase gap embeddings exist to close.
R3 also concedes that **no source measures FTS-vs-embedding quality at the small
post-filter candidate-set size Quorum actually operates in** — the ruling rests
on extrapolating from large-corpus benchmarks downward, which is an argument, not
a measurement. The ~30-minute experiment that would settle it (run the demo
fixtures through both, see which surfaces the right item) is named in R3 and was
not run.

**Status.** CLOSED. → [R3](../research/reports/R3-embeddings-vectors.md).

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

**Ruling (closed by R4).** **Cut confirmed.** Ship `memory_items` +
`memory_audience`, purely relational.

**Why — the cut was tested, not conceded.** The bar was: name three product
queries a graph answers well and a flat relational table answers badly.

| Candidate query | Verdict |
|---|---|
| Single-hop "what do we know about X" | Relational **wins** — Mem0's own benchmark |
| Multi-hop provenance / lineage | Real in the abstract, **not a requirement of this product** |
| Temporal "how did this change over time" | The one case graphs genuinely win — and Quorum already answers it via the `superseded_by` chain |

Looking for three and finding one and a half is the argument.

**The strongest argument against.** The same evidence shows graphs winning
specifically on temporal and branching multi-hop reasoning (Mem0ᵍ +2.6 temporal
J-score; Zep up to 18.5% on temporal/cross-session). And `superseded_by` only
models **linear** supersession — a fact derived from two others, or a branching
provenance question, is a real ceiling, not a hypothetical one. A legal product
is unusually likely to eventually want "trace this instruction back to who
authorised it." Note also that R4's decisive numbers are **vendor
self-benchmarks in both directions**, which is a reason to hold the verdict with
medium rather than high confidence in its *rationale* even where the *decision*
is clear.

**Reopen triggers.** A requirement for branching provenance, or an
authorisation-trace feature.

**Status.** CLOSED. → [R4](../research/reports/R4-memory-architecture.md).

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

**Ruling (closed by R2).** A refinement of (b). **Turn *identity* — chat, actor,
`turn_id` — is fixed once at construction. Every privileged read of mutable
authorisation state (membership, clearance, audience containment) is evaluated
fresh, in SQL, at the moment that read runs.**

**Why.** This is very nearly free: PostgREST already gives each call its own
transaction, so the work is *not caching* rather than building machinery.
Candidate (c) — one long `REPEATABLE READ` transaction around the turn — is
rejected on two counts: it is infeasible under PostgREST's per-request
transaction model, and it is actively harmful, because holding a database
transaction open across a multi-second external LLM call is a documented
anti-pattern that fights Supavisor's transaction-mode pooling by design.
`REPEATABLE READ` RPCs are still right for *short, DB-only atomic writes* — the
idempotent insert, and the `memory_item` + `memory_audience` pair.

**Published guarantee.** *A revocation takes effect on the agent's next
privileged read.* Not "the next turn" — that is weaker than what this design
actually delivers.

**The strongest argument against.** Per-read re-checking **shrinks the TOCTOU
window; it does not close it.** A response already generated from data read
moments before a revocation lands is still delivered, because nothing in this
stack can make the model call itself transactional. "Next read" is not "no
window." There is also a documentation cost: a context that visibly *holds* its
state is an easier mental model than one that deliberately refuses to.

**Consequence.** This corrected the README and `ARCHITECTURE.md`, both of which
said the context "resolves **and holds**" the member set — wording that
instructed an implementer to build the exact gap this project claims not to have.

**Status.** CLOSED. → [R2](../research/reports/R2-authz-concurrency.md).

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

**Ruling (partially closed by R8).** **Shape settled:** client-generated
`client_message_id`, a permanent `UNIQUE (chat_id, client_message_id)`,
`turn_id` for correlation, at-least-once delivery. **No distributed lock, no
transactional outbox** — both are over-engineering at this scale. The
`llm_calls` row is written **before** the model call, so a crash mid-call is
still accounted for.

**Still OPEN: partial-turn resume semantics.** The case where a retry arrives
after the message was persisted but before the reply was — the model call has
already succeeded and already been billed. R8 offers two disjoint strategies (a
durable step record vs. an explicit `turn` state machine) and finds authority for
neither in the multi-table single-Postgres case.

**Decision for v1:** partial-turn recovery is **out of scope**, and
`ARCHITECTURE.md` says so explicitly rather than showing only the happy path.

**What would close it.** `tests/agent/turn-idempotency.test.ts`: persist a
message, fail the reply insert *after* the model call succeeds, retry the same
`client_message_id`, assert exactly one `llm_calls` row for that `turn_id` and
exactly one agent reply. Until that passes, this is "design settled,
implementation unverified" — and it should be described that way, not as done.

**Status.** PARTIAL. → [R8](../research/reports/R8-idempotency.md).

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

---

## D-019 — Agent tool authority is chat-scoped

**Context.** In a group chat, whose permissions does the agent act with? The
union of all members', the intersection, or the invoking user's? These give
materially different answers and the design had never stated which.

**Decision.** **Neither union nor intersection: the chat's own.** A turn's
effective authority is exactly the chat's active member set and its clearance
floor — which is precisely what `ScopedAgentContext` already resolves from
`chat_id`. Paired with the tested invariant that **no context method accepts a
scope-defining id as a parameter**, since tool input is transitively
model-controlled and therefore injection-influenceable.

**Why.** Union leaks: the agent would answer using a fact only one member is
cleared for. Intersection is unusable: in a twelve-person chat it collapses to
near-nothing. Chat-scoped is also the only one of the three that composes with
the memory rule, which is already stated in terms of the chat's member set.

**Against.** It cannot distinguish admin from ordinary member within one chat.
A future admin-only tool needs a per-member role check *in addition*. Also, R6
found **no comparable published system** for this multi-member-chat case — the
delegation literature covers single-user delegation. This is Quorum's own
extrapolation, and should be presented that way.

---

## D-020 — The judge returns a discrete verdict, not a thresholded float

**Context.** `config/agent.ts` had `judgeSpeakThreshold: 0.7`, compared against a
model-reported confidence.

**Decision.** **Killed.** The judge returns `respond | silent` plus a one-line
reason, via the API's structured-outputs surface (`output_config.format`).

**Why.** LLM self-reported confidence is not calibrated well enough to threshold
on; comparing a model-authored float to 0.7 is theatre dressed as rigour. The
README already said "a verdict plus a one-line reason" — the prose was right and
the config was wrong, so the config changed.

**Against.** A discrete verdict discards gradient information and forecloses
cheap later tuning (a different bar for DMs than for large groups). A
score-plus-verdict hybrid — gate on the discrete field, log the score for future
calibration — would keep both. The all-discrete choice is a 12-hour-budget
simplification, not strictly better.

**Note.** R5 recommended a *forced tool call* as the mechanism. That is dated;
structured outputs are the current surface. The conclusion survived, the
mechanism did not.

---

## D-021 — No memory reflection or consolidation in v1

**Decision.** A named **non-goal**. `MEMORY.lifecycle` decays and supersedes; it
does not merge related facts into higher-order summaries.

**Why.** Consolidation is where memory systems get expensive and unpredictable,
and it is not on the path to anything the brief asks for. Naming it as a
deliberate non-goal is better than leaving it looking unconsidered.

---

## D-022 — Least-privilege turn scoping after untrusted content

**Context.** The file and web tools introduce attacker-controlled text into the
model's context. `config/agent.ts` carried a comment asserting that a tool result
"can never authorise a further privileged call" — enforced nowhere.

**Decision.** Make it real. **Once a turn has ingested untrusted tool content, it
may only call tools on `TOOLS.postUntrustedAllowlist` for the remainder of that
turn.** The list starts empty: no further tool calls at all. Enforced in
`lib/agent/orchestrator.ts`, asserted in `tests/config.test.ts`.

**Why.** Delimiting and provenance-fencing untrusted content is defence in depth,
not a mitigation — the evidence does not support treating a fence as a control.
The structural version is to remove the *capability*, which is the same move the
memory rule makes: prevent rather than persuade.

**Against.** It makes legitimate multi-step research harder — read a page, then
search again — which is why `research` is a separate user-invoked turn type
rather than something the automatic loop does.

---

## D-023 — The clearance ladder is one dimension: sensitivity

**Context.** The ladder was `general(0) → internal(1) → external_audit(2) →
internal_exec(3)`, compared with a monotone `have.level >= required.level`.

**The problem.** `external_audit` names **who is in the room**. The others name
**how sensitive the material is**. One integer cannot express both, and the
conflation produced a real bug: a fact marked `internal(1)` was eligible to
surface into an `external_audit(2)` chat purely because 2 > 1 — an internal fact
reaching a room with outsiders in it. Audience containment usually blocks that,
but relying on the second axis to rescue a mis-modelled first axis is not the
design the README describes.

**Decision.** Pure sensitivity rungs: `general(0)` / `internal(1)` /
`confidential(2)` / `restricted(3)`. Nothing in the ladder names a team, a
department, or who is present.

**Why.** The team-flavoured names were only ever meant as *examples of clearance
levels*, never as a hierarchy of groups. Teams are what `chat_members` models;
sensitivity is what clearance models. Keeping each axis to one meaning is what
lets the README claim they are independent without a caveat — and it keeps the
demonstration of the authorisation axis simple, which was the whole point of
D-003's "sufficient to demonstrate, not a real entitlement system".

**Against.** A single sensitivity ladder cannot express compartmentalisation —
real clearance systems are lattices, not ladders, precisely so that "Secret,
Project A" does not imply "Secret, Project B". Quorum's ladder deliberately does
not model that, and it should not be described as if it did.

---

## D-024 — `turn_id` and `request_id` are both required; no traces table

**Decision.** `turn_id` correlates every row a turn produces across
`agent_events` and `llm_calls`; `request_id` identifies the delivery attempt. A
retry resumes the same `turn_id` under a new `request_id`. `messages.turn_id`
closes the hole where the idempotency step had nothing to return.

**No `traces` table** — the trace *is* the join. **No `tool_calls` table** — a
tool span is a `tool_invoked` / `tool_result` pair sharing a `tool_call_id` in
`payload`. Both follow from the extensibility charter on its own terms: a new
event type costs no migration, a new table does.

**Against.** Two ids is more ceremony than a 12-hour build strictly needs, and
one could reconstruct attempts from timestamps. It stops being reconstructable
the moment two attempts overlap, which is exactly when it matters.

---

## D-025 — The space view renders SVG, not canvas

**Decision.** `d3-force` with SVG.

**Why.** The original plan said canvas "since node counts can grow". They will
not — this is a demo with a few hundred nodes at most, and canvas costs
hand-rolled hit-testing and leaves nothing for a screen reader, in the feature
that is *first to be cut* (D-017). Paying an implementation tax on the least
graded surface is the wrong trade.

**Against.** If node counts ever did grow past a few thousand, SVG's DOM cost
becomes the bottleneck and this is a rewrite rather than a tune.

---

## D-026 — The idempotency RPC runs at READ COMMITTED, not REPEATABLE READ

**Context.** R14 recommended that the turn's write path be a `SECURITY DEFINER`
function opened at `REPEATABLE READ`. The function was built; the isolation
level was not.

**Decision.** `send_message_and_start_turn()` runs at the default READ
COMMITTED.

**Why.** The recommendation was made about a *general* multi-table write path.
This function does one thing: an idempotent insert keyed on
`(chat_id, client_message_id)`. `ON CONFLICT DO NOTHING` resolves the only race
that exists — two concurrent deliveries of the same key — and it resolves it at
READ COMMITTED. Raising the isolation level would add `40001` serialization
failures and a retry loop to every send, to buy nothing.

Isolation earns its cost where a function reads several tables and must see one
consistent snapshot across them. This one does not. Taking the recommendation
because a report made it, without checking whether its premise applied, would
have been cargo-culting.

**Against.** If the function later grows to write `memory_items` and
`memory_audience` atomically alongside the message — which is a plausible
Tier 2 move — the premise changes and this decision must be revisited. The
reasoning is recorded in the migration itself so that whoever extends it sees
why the level is what it is.

---

## D-027 — Discovery is gated on clearance, but not on membership

**Context.** Groups must be discoverable or the join-request flow cannot exist:
you cannot ask to join something you cannot see. The first implementation made
*every* group discoverable.

**Decision.** A group is visible to a non-member only if they meet its clearance
floor. DMs and agent chats are never discoverable.

**Why.** The first version leaked the existence of clearance-gated rooms to
everyone. The existence of a restricted conversation is itself disclosure —
"there is a Restricted channel called Project Halifax" is information. Gating
discovery on clearance but not membership keeps the join flow working while
making the README's claim true of discovery and not only of content.

**Found by writing the clearance tests**, not by review. The scenario only
becomes obvious when you try to assert it.

**Against.** A user who is a member of a gated chat but has *lost* the clearance
can no longer see a chat they are still formally in, which is a confusing state
to render in a UI. The alternative — showing it but refusing entry — discloses
its existence, so the confusing state is the safer one.

---

## D-028 — No separate agent-turn endpoint

**Context.** `docs/ARCHITECTURE.md` listed `api/agent/turn/route.ts` as the
agent pipeline entry point. It does not exist.

**Decision.** The turn runs inside `after()` from the message route. There is no
second endpoint.

**Why.** A separate endpoint would mean a second HTTP round-trip and a second
authorisation check, for a caller that is our own server already holding a
verified actor and a `turn_id` from the RPC. It would also need its own
authentication story — an internal endpoint that starts agent turns is an
attractive thing to be able to call directly.

Running in `after()` keeps the send fast (the response returns as soon as the
message is persisted) and the reply arrives over Realtime, which is the same
path a reply from another human takes.

**Against.** It couples the turn's lifetime to the request's invocation, so a
turn cannot outlive `maxDuration`, and there is no way to re-trigger a turn
without re-sending a message. If turns ever need to be replayed or run longer
than an invocation, this becomes a queue and an endpoint — which is exactly the
"when would you introduce a queue" question R9 answered, and the trigger is
recorded there.

---

## Known limits that research could not close

Recorded here rather than left to look like oversights.

- **Fabricated-but-authorised memory.** `source_type` defends against
  *misattribution*, not *fabrication*. A user asserting a false claim about a
  colleague produces a correctly-authorised `inferred` item that is eligible to
  surface. Not closable within this budget; stated as a limitation.
- **Aggregation across separately-authorised answers.** Two individually
  authorised answers in one chat can let a human infer a third, unauthorised
  fact. No system surveyed claims to solve this; the literature names it open.
- ~~**Whether `auth.uid()` survives a `SECURITY DEFINER` role switch.**~~
  **RESOLVED empirically — it does.** R1 could not source this from primary
  documentation and inferred it from two documented facts, so rather than build
  the membership predicate on an inference it was settled first, against a real
  Postgres 18.4: GUCs are session-scoped and the role switch does not reset
  them. Asserted in `tests/authorization/rls-foundation.test.ts`, which also
  pins that the test role cannot bypass RLS and *does* hold table grants — so a
  denial in any later test comes from the policy, not from a missing `GRANT`.
- **`GATE.judgeContextMessages: 8`.** No source gives a principled number. Not
  contradicted; also not derived. Describe it as chosen, not derived.
- **The false-positive/false-negative asymmetry behind D-008.** The direction is
  asserted across the proactive-agent literature; the magnitude is quantified
  nowhere. State bias-toward-silence as a design *stance*, not a measured
  tradeoff.
