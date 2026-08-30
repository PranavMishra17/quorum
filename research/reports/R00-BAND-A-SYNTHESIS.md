# R00 — Band A synthesis, and the decisions it closes

**Band:** A (synthesis) · **Closes:** D-004, D-007, D-009 · **Partially closes:**
D-011 · **Opens:** D-019, D-020, D-021 · **Status:** complete

Inputs read in full: `R1-postgres-rls.md`, `R2-authz-concurrency.md`,
`R3-embeddings-vectors.md`, `R4-memory-architecture.md`, `R5-response-gating.md`,
`R6-agent-tool-authz.md`. Cross-band inputs consulted where a Band A decision
depends on them: `R8-idempotency.md` (B), `R16-industry-landscape.md` (C),
`R14-postgres-transactions.md` (C, via R2's quotation of it). Repo inputs:
`README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `config/agent.ts`,
`config/models.ts`, `config/env.ts`, `research/RESEARCH.md`.

This synthesis is deliberately adversarial toward its own inputs. Where a report
argues past its evidence, that is said here rather than laundered into a verdict.
Section 6 is the one that matters most: it lists what the research shows is
**wrong** in `README.md` and `docs/ARCHITECTURE.md` today.

---

## 1. Decision table

| Decision | Verdict | Confidence | Supporting report(s) |
|---|---|---|---|
| **D-004** Embedding provider | **CLOSED — no vector provider in v1.** Rank on Postgres FTS (`ts_rank`) + recency + speaker presence. `lib/memory/embed.ts` ships as an unimplemented interface; Voyage AI is the named later upgrade. No ANN index in v1; if vectors are ever added, HNSW, never ivfflat. | **Verdict: high. Rationale: medium** — see §2 and §4.4 | R3 |
| **D-007** Graph memory (`memory_nodes`/`memory_edges`) | **CLOSED — cut confirmed.** Three graph-favouring product queries could not be named for this product. Ship purely relational. | **High on the verdict, medium on the cited benchmarks** (§4.5) | R4 (§8) |
| **D-009** Authorisation consistency mid-turn | **CLOSED — turn identity is fixed at turn start; every privileged read of mutable authorisation state is evaluated fresh, in SQL, at the moment that read runs.** Not one long transaction. | **High** — the best-sourced decision in the set | R2 (primary), R14 (narrowed, not followed) |
| **D-011** Agent-turn idempotency | **PARTIALLY CLOSED.** Shape settled: client-generated `client_message_id`, permanent `UNIQUE (chat_id, client_message_id)`, `turn_id` correlation, at-least-once delivery, no lock, no outbox. **Partial-turn resume semantics remain OPEN.** | Shape: **high**. Resume: **not closed** | R8 (Band B), R2 (ratifies the RPC scope) |
| **D-019** *(new)* Agent tool authority is chat-scoped | **PROPOSED — adopt.** A turn's effective authority is the chat's own member set and clearance floor, never the union or intersection of individual members' standing. | **Medium** — R6 flags, and R16 confirms, that no comparable published system was found | R6 (§5), R16 (negative result) |
| **D-020** *(new)* Judge returns a discrete verdict, not a thresholded float | **PROPOSED — adopt, with R5's *mechanism* corrected.** Kill `GATE.judgeSpeakThreshold: 0.7`. Use the API's structured-outputs surface (`output_config.format`), **not** the forced tool call R5 recommends. | Conclusion: **high**. R5's proposed mechanism: **superseded** (§4.3) | R5 (§4), current Anthropic API reference |
| **D-021** *(new)* No reflection/consolidation step in v1 | **PROPOSED — adopt as a named non-goal.** `MEMORY.lifecycle` decays; it does not merge. | **Medium-high** | R4 (§4) |

Nothing in this table is a rubber stamp of a prior leaning. D-004 and D-007
happen to land where `docs/DECISIONS.md` was already leaning; §2 states why that
is the evidence and not the anchor, and §4 states where the evidence is thinner
than the reports claim.

---

## 2. The rulings

### D-004 — Embedding provider

**Ruling.** No embedding provider is wired into the retrieval path for v1.
`lib/memory/retrieve.ts`'s rank step scores an already-authorised candidate set
using Postgres full-text search (`ts_rank` over a generated `tsvector` column) in
place of cosine similarity, blended with the existing recency and
speaker-presence weights. `lib/memory/embed.ts` ships as a typed, unimplemented
interface. Voyage AI is the named upgrade path (Anthropic's own documented
recommendation; its free-token grant trivially covers this project's scale).

**Reasoning.**
1. Anthropic ships no embeddings API, so any vector ranking costs a second vendor,
   a second key, and a second failure mode inside a 12-hour budget (R3 §1).
2. Local/in-process models on Vercel are a packaging and cold-start risk with no
   time to debug them (R3 §2).
3. The decision is *reversible by construction*: the authorisation filter is set
   containment plus an integer comparison and does not depend on the ranker at
   all. Adding a ranking signal is a rank-step change per the extensibility
   charter. This — not the cost argument — is the real reason the decision is
   safe to take.
4. Not adding vectors also removes a live footgun. R3 §5 is the most valuable
   finding in that report: a naive `WHERE <authz filter> ... ORDER BY embedding
   <=> $1` query scans the ANN index *first* and applies the filter to whatever
   it returns, silently under-returning authorised, on-topic memories (demo:
   15 true neighbours vs 11 through HNSW at default `ef_search`; pgvector's own
   `iterative_scan` exists to correct exactly this). Quorum's filter-in-SQL /
   rank-in-TypeScript split structurally avoids that. That split should now be
   documented as load-bearing, not as a convenience.
5. If vectors are ever added: **HNSW, not ivfflat.** At Quorum's row counts
   pgvector's own `lists = rows / 1000` formula degenerates to 1, and Supabase's
   docs name HNSW the default and the only one safe to build on a near-empty
   table. Below a few thousand rows, pgvector's own documentation says a
   sequential scan may simply be faster than either.

**The counter-case, stated fairly.** Postgres FTS matches lexemes, not meaning —
this is not a hedge, it is in the Postgres documentation. Quorum is pitched as a
legal product, where the gap between how a fact was phrased when learned
("Delaware governing law") and how it is needed later ("the client's
choice-of-law clause") is precisely what embeddings close. If a demo depends on a
memory surfacing under paraphrase, the FTS ranker will visibly fail it. R3 found
**no** evidence measuring FTS-vs-embedding quality at the small candidate-set
sizes this design produces; every comparison it cites was measured at
large-corpus scale where vectors' advantage is well established but not obviously
transferable. Additionally — and R3 does not say this — R3's central premise
("the filter reduces the candidate set to tens of items") is sourced to
`MEMORY.retrieval.globalItemCap: 24`, which is the **output** cap, not a bound on
the post-filter candidate set. The authorised candidate set is in principle
unbounded; it is small here because this deployment is small, not because the
architecture makes it small. The verdict survives that (a take-home deployment
really will hold dozens of rows), but the *argument* is weaker than R3 states.

**Refinement on R3's own recommendation.** R3 says to keep a nullable, unindexed
`embedding vector(1024)` column in `0006_memory.sql` while simultaneously warning
(§7) against baking a provider-specific dimensionality into the schema. Those two
sentences are in tension: `vector(1024)` pre-commits to Voyage's default and would
not accept OpenAI's 1536-dim output without truncation. Since migrations are
additive and append-only anyway, **omit the `embedding` column entirely in v1**
and introduce it — with its `embedding_model text` companion — in the same
additive migration that introduces a provider. That is strictly more consistent
with the extensibility charter than pre-committing a dimension.

### D-007 — Graph memory

**Ruling.** **Cut confirmed.** No `memory_nodes` / `memory_edges`. Ship the
relational model.

**Reasoning — and this is the part that has to be reasoning, not concession.**
R4 was asked to name three product queries a graph answers well and a flat
relational table answers badly. It found one and a half:

| Candidate query | Verdict |
|---|---|
| "What does the agent know about Alice?" | Relational **wins**. Single-hop `WHERE subject_user_id = ?`. Mem0's own LOCOMO numbers show its flat variant beating its graph variant on single-hop (J=67.13 vs 65.71). |
| "Through what chain of people/chats did this fact reach here?" | Genuinely graph-shaped, and genuinely **not a product requirement**. Nothing in the brief, README, or architecture doc asks it. Quorum's authorisation model deliberately reduces this to one set-containment check against a frozen snapshot — a different question with a different cost. |
| "How has the client's requirement changed over time?" | The one case the literature genuinely favours graphs (Mem0g +2.6 J on temporal; Zep reports up to 18.5% on LongMemEval temporal/cross-session). **Already answered relationally** by `memory_items.superseded_by` — a self-referencing linked list walked one foreign key per hop. |

Three cannot be named. That is the finding, and the cut follows from it rather
than from squeamishness about scope.

**The counter-case, stated fairly.** The same evidence that supports the cut
shows graphs winning specifically on temporal and multi-hop relational reasoning
— and a legal product is unusually likely to eventually want exactly that
("trace this instruction back to who authorised it"). `superseded_by` handles
*linear* supersession only; it cannot express a fact partially derived from two
others, or explain *why* a fact changed rather than merely that it did and in
what order. That is a real ceiling, not a hypothetical one. Two concrete reopen
triggers, both of which should be written into D-007 rather than left implicit:
(a) a product requirement for a first-class provenance/lineage view appears; or
(b) `memory_items` volume grows to where `WITH RECURSIVE` walks over
`superseded_by` stop being effectively O(1). Neither holds today.

### D-009 — Authorisation consistency mid-turn

**Ruling.** Adopt R2's sentence verbatim as the published consistency model:

> Turn *identity* (chat, acting user, `turn_id`) is fixed once at turn start.
> Every privileged read of mutable authorisation state — membership, clearance,
> and the memory-audience containment check — is evaluated fresh, in SQL, at the
> moment that specific read runs, in its own request-scoped transaction. A
> membership or clearance change takes effect on the very next privileged read
> within the same turn, not merely "the next turn." What cannot be undone is a
> response already generated from data read *before* the change — no design that
> keeps the model call outside a database transaction can close that residual
> gap, and Quorum should say so rather than imply otherwise.

**Reasoning.** This is the best-evidenced decision in the set, and unusually, the
stronger guarantee is also the cheaper one.

1. Candidate (c) — wrap the turn in one `REPEATABLE READ` transaction — is not
   merely unnecessary, it is actively wrong here. It would hold a pooled
   connection open across a multi-second external model call, in exactly the
   pooling mode (Supavisor transaction mode) Supabase recommends for serverless
   and which is designed around short transactions.
2. Candidate (b) — re-check per privileged read — is **the stack's default
   behaviour**, not an added feature: each PostgREST request is its own implicit
   transaction, and there is no client-side `BEGIN`/`COMMIT` spanning two
   `.from()` calls. Holding a snapshot would require *building* something
   (a wrapping RPC held open across the model call); re-checking requires only
   the discipline of not caching.
3. It matches the external norm. OWASP says re-check per request. Zanzibar
   re-evaluates per check with at-least-as-fresh semantics and explicitly rejects
   global synchronisation. AWS IAM publishes eventual consistency with no bound;
   Google Cloud IAM publishes minutes-to-hours and notes that *grants propagate
   faster than revocations*. Quorum's single-digit-second bound is already
   stronger than either.
4. Half the problem is already gone by construction: the `memory_audience`
   snapshot is immutable after write, so the C1 side of the surfacing rule has no
   TOCTOU surface at all. What remains live is the C2 side — current membership
   and current clearance of the chat retrieval is happening in — and that is
   exactly what per-read evaluation covers.

**The counter-case, stated fairly.** Per-read re-checking shrinks the window; it
does not close it. A removal landing at t+3.0s after the last privileged read at
t+2.9s still yields a response generated from stale data, and that response is
delivered. "Next read" is not "no window." The honest claim is a bound, not a
guarantee — and there is no design in this stack that gets true atomicity across
an LLM call. A second, narrower objection: it costs a slightly less simple mental
model ("this method hits the DB every call" rather than "this object is a
snapshot") — which is precisely why the current documentation says the wrong
thing (§6).

### D-011 — Agent-turn idempotency

**Ruling — partial.** Two halves; only one closes.

**Closed (high confidence).** At-least-once delivery with an idempotent turn.
A client-generated `client_message_id` (UUID minted at compose time, before any
network call, so the client can also render optimistically and reconcile on that
key), enforced by a **permanent** `UNIQUE (chat_id, client_message_id)` — no TTL,
no pruning window; Stripe's 24-hour prune is a Stripe-scale artefact, not a law.
`INSERT ... ON CONFLICT DO NOTHING` closes the concurrent-retry race atomically.
No distributed lock and no transactional outbox: both are disproportionate for
four tables in one Postgres instance with no message broker.

**Also closed (medium-high), by ruling rather than by evidence.** R8 offers two
disjoint partial-failure strategies and finds no authority for either. They share
one primitive, and that primitive can be ruled on now: **the `llm_calls` row (or
at minimum a `model_call_started` `agent_events` row) is written before the
outbound model call fires, never after it returns.** A crash mid-call then leaves
a detectable in-flight marker rather than silence, and a retry can ask "did this
turn already pay for a model call?" before spending again. This costs one index
(`llm_calls(turn_id)`) and one reordering.

**Not closed.** What the orchestrator *does* when it finds that marker — resume
from the last completed step, or refuse and surface the partial turn — is
undecided, untested, and is real engineering work rather than a research
question. R8 says so itself: "design settled, implementation unverified."

**Evidence-availability note, as instructed.** R8 is Band B; it has been run and
is complete, so this synthesis is not reasoning without evidence — but it is
reasoning outside its assigned band, and the ruling above should be re-ratified
when D-011 is formally closed. One flagged gap in R8 is now closed: R8 could not
confirm whether the Anthropic Messages API offers server-side idempotency. The
current bundled Anthropic API reference documents `x-api-key`, `anthropic-version`
and `anthropic-beta` headers and no idempotency-key mechanism on `POST /v1/messages`
(the Batches API's `custom_id` is a result-correlation field, not request
dedup). Treat "idempotency for the model call is entirely Quorum's
responsibility" as **confirmed against the current reference**, though not
against a live fetch of `platform.claude.com`.

### D-019 (new) — Agent tool authority is chat-scoped

**Ruling.** A turn's effective authority is exactly the chat's own member set and
clearance floor, resolved from `chat_id`, independent of which member's message
triggered the turn. Not the union of members' individual standing; not a
per-member intersection either — Quorum's data model carries no individual
tool-permission grants separate from chat membership. This is D-005's
audience/clearance logic generalised from memory visibility to tool authority.

Paired invariant, which is the part that actually does work: **no
`ScopedAgentContext` method accepts a scope-defining id** — no `chat_id`, no
other user's `id`, no other `turn_id`. Methods take within-scope ids
(`file_id`, `message_id`) and resolve them against the chat bound at
construction. This is the literal fix for the Hardy-1988 confused-deputy pattern:
the caller naming a resource must not be sufficient to reach it. `Tool` input
schemas inherit the same rule — a tool's Zod schema must never contain a field
that designates a chat, a user, or a turn.

**The counter-case.** Chat-scoped authority cannot distinguish an admin from a
regular member of the same chat. The moment a tool needs "admins only" (export,
destructive action, invite), chat scope is insufficient and a `chat_members.role`
check is needed *in addition*. None of the planned tools need it — so this is an
acceptable, explicitly-named limitation, not a silent gap. Second objection: R6
found no published system with a comparable chat-scoped model, and **R16 has since
been run and confirms the negative** — Glean's published model is per-user ACL
mirroring, not resource-as-tenant. So R6's fallback framing is now the operative
one: *no directly comparable published system was found; this is Quorum's own
generalisation of its own memory-authorisation rule*. Say that in the README
rather than implying an industry pattern is being followed.

### D-020 (new) — Judge verdict schema

**Ruling.** Delete `GATE.judgeSpeakThreshold: 0.7`. The judge returns
`{verdict: 'respond' | 'silent', reason: string}`. Any numeric confidence is a
logged display field, never the compared value.

**Reasoning.** R5's calibration finding is a direct hit: verbalised LLM
confidence saturates at coarse values and is not intrinsically calibrated, so
thresholding at 0.7 without a calibration procedure "systematically misroutes
traffic and the errors are invisible." A hardcoded float with no calibration
procedure attached is theatre. A categorical verdict is something the model is
actually asked to commit to.

**R5's mechanism is superseded — this matters for `lib/llm/provider.ts`.** R5
recommends obtaining that verdict via a forced tool call
(`tool_choice: {type: 'tool', name: 'gate_verdict'}`), citing the tool-use docs as
"the documented, primary way to get schema-constrained structured output." That
is no longer current. The Messages API now has first-class **structured outputs**
via `output_config: {format: {...}}` (with `strict: true` available on tool
definitions separately); the older `output_format` parameter is deprecated.
`provider.structured()` should be built on `output_config.format`, not on forced
tool use. R5's *conclusion* stands; its *mechanism* should not be copied into
code.

**The counter-case.** A discrete verdict discards gradient information and
forecloses cheap future policy tuning ("speak above 0.85 in large groups, above
0.5 in DMs"). The calibration literature argues against *trusting* a threshold
blindly, not against a threshold existing. A more sophisticated design would
return both, log the score, and gate on the discrete field — which is a
strictly-better design that a 12-hour budget is the only reason to skip. A
reviewer could fairly push on that, and the honest answer is "resource
constraint," not "better engineering."

### D-021 (new) — No reflection/consolidation in v1

**Ruling.** Record as an explicit non-goal, the way D-007 records the graph cut.
`MEMORY.lifecycle` handles decay (TTL, supersession); nothing merges many small
facts into a higher-level summary the way Park et al.'s reflection step does.
This is a real absence, not a confirmed non-requirement — and naming it as a
decision is the difference between discipline and oversight. `tests/memory/
lifecycle.test.ts` has no consolidation test because there is no consolidation
feature; that is consistent only once the non-goal is written down.

---

## 3. What cannot be closed on this evidence

| Open item | Why it cannot close | Precisely what would close it |
|---|---|---|
| **D-011's partial-turn resume semantics** | R8 offers two disjoint strategies (durable-outbox-style step record vs. explicit `turn` state machine) and finds authority for neither; the multi-table single-Postgres case is not what either cited pattern addresses. | A ruling on which strategy, plus `tests/agent/turn-idempotency.test.ts`: persist a message, fail the reply insert *after* the model call succeeds, retry the same `client_message_id`, assert exactly one `llm_calls` row for that `turn_id` and exactly one agent reply. Until that test passes, D-011 is "design settled, implementation unverified." |
| **FTS vs. embedding quality at small candidate-set sizes** | R3 admits it: every comparison found was measured at large-corpus scale. No source measures the regime Quorum actually operates in. | The ~30-minute experiment R3 names: run the planned demo memory fixtures (a handful of deliberately paraphrased facts) through both `ts_rank` and one free-tier Voyage call, and compare which surfaces the right item within the 24-item cap. This is an experiment against fixtures, not more literature. |
| **Fabricated-but-authorised memory** | R4 §6 establishes that `source_type` defends against *misattribution*, not *fabrication* — a false claim about a colleague is still stored as `inferred` and is still eligible to surface. R6 §6 explicitly routes induced misuse of correctly-authorised content to R7 (Band B, not read here). **No Band A report closes this**, and neither claims to. | Not closable by research within this budget. The correct move is to record it as a stated limitation, not to leave the README implying provenance solves poisoning. |
| **Aggregation across separately-authorised answers** | R16 §6: two individually-authorised answers in one chat can let a human infer a third, unauthorised fact. No system reviewed claims to solve it; the survey names it an open problem. | Nothing available. State it as a known limit of item-level filtering. |
| **The false-positive/false-negative cost asymmetry behind D-008** | R5 §5: the direction is asserted across the proactive-agent literature; the magnitude is quantified nowhere. | A domain user study (not feasible). Practical resolution: state bias-toward-silence as a design *stance* consistent with how production bots behave, not as a measured tradeoff. |
| **Whether `auth.uid()` survives a `SECURITY DEFINER` role switch** | R1 §5 flags honestly that it could not find this stated verbatim in a primary Supabase or Postgres source — it is inferred from two documented facts (SECURITY DEFINER changes role for privilege checking; GUCs are session-scoped). **The entire membership-predicate design rests on it.** | A one-line local test, and it should be the *first* assertion in `tests/authorization/rls.test.ts`: set `request.jwt.claim.sub`, `SET ROLE authenticated`, call a `SECURITY DEFINER` function returning `auth.uid()`, assert round-trip. |
| **`GATE.judgeContextMessages: 8`** | R5 §3: no source gives a principled number for a speak/stay-silent judgement. 8 is not contradicted; it is also not derived. | Nothing cheap. Keep the value; describe it as "chosen, not derived" wherever it is written up. |

---

## 4. Contradictions and tensions between the reports

### 4.1 R2 vs. R14 — the sharpest disagreement, and R2 wins

R14 (Band C) leaned toward D-009 candidate (c): run the turn under
`REPEATABLE READ` in a Postgres RPC. R2 explicitly narrows that to *short,
DB-only, no-external-call* operations and recommends against applying it to the
agent turn. **R2 is correct and should govern.** R14's example (writing a memory
item without a concurrent write changing the audience underneath it) is about
write-time atomicity of a fast operation; D-009 is about whether a multi-second
turn is one read snapshot. Those are different questions that R14 partially
conflates. Practical split:

- **RPC + explicit transaction — yes:** the idempotent message insert, and the
  atomic `memory_items` + `memory_audience` insert pair at extraction time.
- **RPC + transaction across the turn — no.**

### 4.2 R2 vs. R6 — reconcilable, but the docs currently take the wrong half

R6 treats "authority bound once at construction from a `chat_id`" as the property
that makes `ScopedAgentContext` capability-style rather than ambient. R2 says the
member set and clearance must **not** be held from construction. These are not in
conflict once separated:

> **Designation** is bound at construction (which chat, which actor, which
> `turn_id`) and is immutable. **The authorisation predicate** is evaluated fresh
> on every privileged read.

That distinction needs to be stated explicitly in `lib/db/scoped-agent.ts`,
because the current documentation collapses the two and lands on the caching
side (§6).

### 4.3 R5 vs. the current Anthropic API — R5's mechanism is dated

Covered in D-020. R5's `tool_choice` forced-call recommendation predates
first-class structured outputs (`output_config.format`). Downgrade that specific
recommendation; keep the conclusion.

### 4.4 R3 vs. R4 — an unnoticed dependency

R4 §4 analyses `MEMORY.retrieval.weights` by mapping it onto Park et al.'s
recency/importance/relevance formula, treating the `similarity: 0.6` term as
embedding relevance. R3 removes embeddings from v1 and repurposes that same term
as `ts_rank`. Not a contradiction, but R4's analysis was written on a premise R3
invalidates, and the config field name (`similarity`) now describes a signal that
does not exist. Rename it `relevance` so the field is source-agnostic and the
future swap really is a rank-step-only change.

Related and worse: `MEMORY.retrieval.similarityFloor: 0.3` is commented
"Cosine-similarity floor." With no vectors there is no cosine similarity, and
`ts_rank` values do not live on a 0–1 cosine scale. Left as-is, that constant
silently means nothing — the exact failure mode CLAUDE.md's "no magic numbers"
rule exists to prevent.

### 4.5 R4's decisive numbers are vendor self-benchmarks — both directions

R4's "relational wins single-hop" number (Mem0 flat J=67.13 vs Mem0g 65.71) comes
from Mem0's own paper evaluating Mem0's own graph variant. Its "graphs win
temporal" number (up to 18.5%) comes from Zep's own paper about Zep. Both are
vendor-graded, in opposite directions, and neither should carry load. **The D-007
verdict does not depend on them** — it rests on two internal, checkable facts
(query 2 is not a product requirement; query 3 is answered by `superseded_by`).
State the verdict on those grounds and cite the benchmarks as colour.

### 4.6 R5's evidence supports a stronger cut than the design took

R5 §1–2 is more damaging to the judge than R5's own recommendation admits: the
one adversarially-designed benchmark for text-only addressee recognition put
GPT-4o at 80.9% against an 80.1% majority-class baseline — statistically
indistinguishable from always guessing — and deployed multi-party bots
overwhelmingly *avoid* the problem via explicit mention rather than solving it.
A defensible reading is that the judge should be cut entirely and the gate should
be the deterministic chain alone. D-008 keeps it, which is fine, but the honest
framing is: *the judge exists for product feel; the evidence does not support
claiming it is accurate.* R5's mitigation (reframe the prompt as "should the
agent, rather than another human, respond next?" — a relevance judgement, not
addressee attribution) is the right narrowing and should be implemented.

### 4.7 R1 vs. R1 — the one internal tension worth flagging

R1 recommends a single combined-predicate `PERMISSIVE` policy per table/command
(`is_active_member AND meets_clearance`), and then argues fairly against itself:
two policy objects (one `PERMISSIVE` for membership, one `AS RESTRICTIVE` for
clearance) map more legibly onto D-003's "two independent axes" claim and are
easier to toggle per-table. Both are mechanically correct. **Keep R1's
recommendation** — the deciding factor is that a combined predicate is harder to
*accidentally weaken* in a later migration (dropping one of two policies silently
regresses to membership-only, which is exactly the level-3/level-0 leak D-003
exists to prevent), and this project is graded on demonstrating that leak is
closed.

---

## 5. Concrete changes this implies

### 5.1 Migrations (`supabase/migrations/`)

| File | Change |
|---|---|
| `0001_extensions.sql` | Keep `vector` (harmless, avoids a later extension migration) but note it is forward-looking — no column uses it in v1. |
| `0003_chats_members.sql` | `create schema private` (never exposed to PostgREST). `private.is_active_member(uuid)` and `private.meets_clearance(uuid)` as `security definer`, `set search_path = ''`, `stable`, schema-qualified inside, **re-applying `(select auth.uid())` internally** and `coalesce(..., false)` so a missing chat row fails closed. `revoke all` from `public/anon/authenticated`, then `grant execute` to `authenticated`. One combined-predicate `PERMISSIVE` policy per table per command, every predicate call wrapped `(select ...)` to force an initPlan, `TO authenticated` stated explicitly. |
| `0004_messages.sql` | `UNIQUE (chat_id, client_message_id)` — permanent, no TTL. |
| `0005_agent_events.sql` | Add `llm_calls(turn_id)` index — the orchestrator must be able to ask "has this turn already paid for a model call?" before issuing one. |
| `0006_memory.sql` | RLS enabled with **zero permissive policies** and no grants to `anon`/`authenticated` — that, not a "deny policy," is how Postgres expresses no-client-access. Add a generated `content_tsv tsvector` column + GIN index. **Do not** add `USING ivfflat`. **Omit** the `embedding` column in v1; introduce it with `embedding_model text` in the additive migration that introduces a provider. Index `memory_audience(memory_item_id, user_id)` rather than `(memory_item_id)` alone — the containment predicate probes both columns *(derived from R1 §7's "index every column a policy filters on"; not stated in any report)*. |
| `0007_files.sql` | `storage.objects` policies reuse the **same** `private.is_active_member` / `private.meets_clearance` functions via `storage.foldername(name)` — do not re-derive a parallel recursion fix. |
| `0008_seed_clearances.sql` | Seed the `config/agent.ts` ladder literally. See §6/C3 — reconsider the rung ordering before this is written, since it is append-only afterwards. |

### 5.2 `config/`

| Change | Why |
|---|---|
| Delete `GATE.judgeSpeakThreshold: 0.7` | D-020. An uncalibrated float used as gate logic. |
| Annotate `GATE.judgeContextMessages: 8` as "chosen, not derived" | R5 §3. |
| Annotate `GATE.cooldownSeconds: 90` as a **throttle** (not a debounce), and name its unmitigated failure mode: a burst of unaddressed but individually judge-worthy messages inside the window gets one answer, not three | R5 §7. Deliberate under D-008; must read as deliberate. |
| Rename `MEMORY.retrieval.weights.similarity` → `relevance` | §4.4. Makes the FTS→vector swap a rank-step change. |
| Delete or redefine `MEMORY.retrieval.similarityFloor: 0.3` | §4.4. It is a cosine threshold in a system with no cosines. |
| Add `MEMORY.retrieval.ranker: 'fts'` | Makes D-004's answer a config-level fact, so upgrading is a config change per the extensibility charter. |
| Add `MEMORY.extraction.neverExtract` — a short, named, reviewable category list (health, government ID numbers, immigration status, criminal history), modelled on Anthropic's own shipped consumer-memory exclusions | R4 §3. Every source converges on a domain list; none derives a general filter. A values list in code, not a classifier. |
| Leave `config/models.ts` alone | Checked against the current Anthropic API reference: model ids, pricing, the `budget_tokens`-removed / `output_config.effort` note, and the Haiku-4.5-rejects-effort note are all correct. |
| Leave `config/env.ts`'s optional `EMBEDDING_API_KEY` | Correct as optional; do not promote it to required. |

### 5.3 `lib/`

- **`lib/db/scoped-agent.ts`** — (a) written contract at the top of the file:
  *no method accepts a `chat_id`, another user's `id`, or another `turn_id`*;
  (b) `isActiveMember(userId)` / `clearanceLevel()` issue a fresh indexed query
  per call — **not** fields populated at construction; (c) construct the client
  from `SUPABASE_SECRET_KEY` alone and never forward an end-user access token on
  the same client, or PostgREST runs the request under that user's role and
  `BYPASSRLS` silently does not apply (R1 §6 — a confusing functional bug, not a
  leak); (d) `BYPASSRLS` does not imply `GRANT`s — any new schema needs its own
  grants to `service_role`.
- **`lib/memory/retrieve.ts`** — filter queries current `chat_members` /
  `user_clearances` live at call time; it must not receive a membership set
  handed down from context construction. If a semantic score is ever added, it is
  computed in TypeScript over already-fetched rows, never as
  `WHERE <authz> ... ORDER BY embedding <=> $1` in one query.
- **`lib/memory/embed.ts`** — ship the interface
  (`embed(text, kind: 'query'|'document'): Promise<number[] | null>`), unwired.
- **`lib/memory/extract.ts`** — include `asserted_by_user_id` explicitly in the
  `memory_written` payload (derived from `messages.sender_id` via
  `origin_message_id`), so the stated/inferred distinction is auditable in the
  internal view without a read-time join. No migration — `payload` is jsonb.
- **`lib/llm/provider.ts`** — `structured()` built on `output_config.format`,
  not on forced tool use (§4.3).
- **`lib/agent/gate.ts`** — judge prompt framed as *"should the agent, rather
  than another human, respond next?"*, never as *"who is this addressed to?"*
- **`lib/agent/orchestrator.ts`** — writes the `llm_calls` row (or a
  `model_call_started` event) **before** the outbound model call. The resume
  behaviour on finding that marker is the part still open (§3).
- **`lib/agent/tools/index.ts`** — the `Tool` interface doc states that
  `inputSchema` may never contain a chat, user, or turn designator.

### 5.4 `eslint.config.mjs` + CI

Add `no-restricted-properties` / `no-restricted-syntax` blocking
`process.env.SUPABASE_SECRET_KEY` (and its `config/env.ts` accessor) outside a
`files`-scoped override for `lib/db/scoped-agent.ts` — restricting the *env read*
rather than the import path catches re-exports and renamed wrappers that an
import-path rule misses. Back it with a CI grep for the same string across
`*.ts`/`*.sql`, which reaches migrations and seed scripts ESLint cannot see.
Neither is a security boundary (both are one `// eslint-disable` away); their
value is converting an accidental violation into a visible, deliberate one.

### 5.5 `tests/`

- `tests/authorization/rls.test.ts` (does not exist yet) — first assertion is the
  `auth.uid()`-survives-`SECURITY DEFINER` round-trip (§3). Run as an
  unprivileged role against a real local Postgres; a service-role client
  bypasses RLS and proves nothing.
- `tests/authorization/membership.test.ts` — add a **turn-shaped** removal test
  alongside the row-level one: build one `ScopedAgentContext`, remove the member
  via a second connection between two calls on that same instance, assert the
  second call denies. A pure RLS test cannot distinguish per-call re-check from a
  cached snapshot that happens to still be correct.
- `tests/agent/gate.test.ts` — replace
  `it.todo('a judge verdict below the speak threshold results in silence')` with
  `it.todo('a "silent" verdict from the judge results in silence')` and
  `it.todo('the judge verdict is schema-constrained, never free-text parsed')`.
  Keep the stub-at-`lib/llm/provider.ts` boundary; never a live model call.
- `tests/agent/turn-idempotency.test.ts` (new) — the crash-mid-turn test in §3.

### 5.6 `docs/DECISIONS.md`

Move D-004, D-007, D-009 to settled with the rulings in §2. Rewrite D-011 as
settled-in-shape / open-in-resume rather than flipping it to settled. Add D-019,
D-020, D-021. Amend D-013/D-014 to record that the numeric
`confidenceThreshold` gate is a **deliberate departure** from the two production
systems surveyed (neither Mem0 nor ChatGPT memory publishes a numeric confidence
mechanism) — Quorum is more conservative here, and that should read as an
informed choice rather than an assumed norm. Amend D-006's *Why* with R16's
Copilot evidence: a live-membership check reproduces the same oversharing class
Copilot ships today, triggered by membership growth instead of grant sprawl.

---

## 6. What the research shows is WRONG in README.md and docs/ARCHITECTURE.md

This is the section that matters most. A confidently-stated falsehood in a graded
README is worse than an omission. Ordered by severity.

### C1 — `README.md` L117–119 and `ARCHITECTURE.md` §3 L119, §4 L158 — the context "holds" its authorisation state. **FALSE, and it builds in the exact vulnerability the project claims to prevent.**

> "`ScopedAgentContext` is constructed once per turn from a chat id. It resolves
> **and holds** the chat's active member set, its clearance level, and the
> requesting user."

`ARCHITECTURE.md` repeats it twice: the §3 pipeline diagram
(`build ScopedAgentContext(chat_id) → member set, clearance, actor`) and the §4
`scoped-agent.ts` contract row ("resolves member set + clearance + actor").
(R2 attributes the "resolves and holds" phrasing to `ARCHITECTURE.md` §1; the
sentence it quotes is actually in `README.md`, and the architecture doc carries
the two paraphrases above. The correction lands in three places, not one.)

Per R2, *holding* the member set across the model call is what creates the TOCTOU
window — and the fix is not merely cheaper than the alternative, it is the
stack's default behaviour, because each PostgREST call is already its own
transaction. As written, the documentation instructs a future implementer to
build the bug. Replace with: identity (chat, actor, `turn_id`) is fixed at
construction; membership and clearance are read fresh per privileged call.

### C2 — `README.md` L71–73 — "RANK **semantic similarity**, recency, speaker presence." **FALSE once D-004 closes.**

There is no semantic similarity in v1. The rank step is lexical
(`ts_rank`) plus recency plus speaker presence. The README currently promises a
capability the shipped system will not have, in the section a reviewer reads most
closely. Fix the line, and add one sentence to *Tradeoffs* stating the reasoned
cut (Anthropic ships no embeddings API; a second vendor was not worth the
12-hour cost; the interface is in place; the filter does not depend on the
ranker). A stated tradeoff reads well; an unmarked overclaim does not.

Related: `ARCHITECTURE.md` §2 L59 lists `embedding vector` on `memory_items` and
L95 lists `memory_items USING ivfflat (embedding vector_cosine_ops)`. Both must
go for v1 — and the ivfflat line is wrong *even if vectors are adopted*, since
`lists = rows/1000` degenerates to 1 at this scale and Supabase's own docs name
HNSW the default.

### C3 — `README.md` L96–98 — "An *External Audit* group is unreachable by a user without **that clearance** regardless of any membership row." **FALSE under the recommended implementation.**

R1's `private.meets_clearance` compares `have.level >= req.level` — a monotone
ladder. `config/agent.ts` puts `external_audit` at level 2 and `internal_exec` at
level 3. Therefore a user holding **only** `internal_exec` satisfies an
`external_audit` requirement and reaches the chat *without holding that
clearance*. The claim is true of the *level*, not of the *clearance*.

Minimum fix: say "without sufficient clearance level."

Deeper issue, flagged as a design critique derived from R1's SQL plus
`config/agent.ts` rather than as a report finding: **`external_audit` is a
category, not a rung.** "An external auditor is in the room" describes *who is
present*, not *how sensitive the material is*, and a single monotone integer
ladder cannot express it — placing it above `internal` implies an internal fact
may surface into a chat containing outsiders whenever audience containment
happens to hold. Audience containment usually blocks that, but relying on the
second axis to rescue a mis-modelled first axis is not the design the README
describes. Either reorder the ladder into pure sensitivity rungs
(`general` / `internal` / `restricted` / `exec`) and model "external parties
present" as a chat attribute, or keep the current keys and state explicitly in
the README that the ladder is a sensitivity ordering in which `external_audit`
sits where it does *because* of what may be disclosed to auditors. **Decide this
before `0008_seed_clearances.sql` is written** — migrations are append-only.

### C4 — `README.md` L107–109 — "Policies **deny** the authenticated role outright." **Mechanically wrong.**

Postgres RLS has no deny policy. Per R1 §2, access is granted by at least one
`PERMISSIVE` policy and narrowed by `RESTRICTIVE` ones; *"If only restrictive
policies exist, then no records will be accessible."* The correct construction
for memory tables is: RLS enabled, **no permissive policy at all**, and grants
revoked from `anon`/`authenticated`. The outcome the README describes is right;
the mechanism it names does not exist, and an interviewer who knows RLS will
notice.

### C5 — `ARCHITECTURE.md` §4 L195–198 — "`execute` **cannot** reach the database except through `ctx`. Tool authorisation is therefore resource-level **by construction**." **Two false claims in two sentences.**

Per R6 §3: (a) nothing in the `Tool` signature prevents a tool module from
importing `lib/db/server.ts` or constructing its own client — the signature
expresses an intent, it does not enforce one; (b) threading a context does not
make a design capability-style. It is capability-style **if and only if** no
`ScopedAgentContext` method accepts a scope-defining id. If any method takes a
`chat_id` from tool input — which is transitively model-controlled and therefore
injection-influenceable — the context has degraded into ambient authority with
extra steps.

Rewrite as a *stated, tested invariant* rather than a property of the type
signature, and carry the same correction into §5's seam table
("authz inherited from `ctx`" is true only under that invariant).

### C6 — `README.md` L61–63 — "The model never receives out-of-scope memory at all... **structural prevention**, not a prompt asking the model to be discreet." **True with a carve-out that must be stated.**

The claim is fully structural for the C1 half of the rule — `memory_audience` is
immutable after write, so there is nothing to race. It is *bounded*, not
absolute, for the C2 half: membership and clearance are live state, and per R2 no
design that keeps the model call outside a transaction can prevent a response
being generated from data that goes stale mid-turn. Separately, R16 §6 notes
item-level filtering does not defend against a human aggregating two
separately-authorised answers into a third, unauthorised inference.

Do not delete the claim — it is the thesis and it is defensible. Qualify it in
one sentence, and state the bound. R2's own framing is stronger than the current
text *and* more honest: a removal takes effect on the next privileged read, not
merely the next turn.

### C7 — `README.md` L262–265 — "cut... **Provisional pending research track R4**." **Now stale.**

R4 has run and confirmed the cut with an argument. Replace the provisional
wording with the actual finding: three graph-favouring product queries were
sought and could not be named — one is answered *better* without a graph, one is
not a requirement of this product, and one is already answered by
`memory_items.superseded_by` — plus the two named reopen triggers. "I looked for
three and found one and a half" is a much stronger sentence than "provisional."

### C8 — `README.md` L195–231 — the test list implies more is proven than can be.

"The agent stays silent in a group when not addressed" reads as a claim about the
judge's accuracy. Per R5 §6, what is testable in this budget is the *pipeline*
(which rules fire, judge invoked only on fall-through, silence on
error/timeout/malformed output, cooldown suppression, mention overrides
cooldown) against a **stubbed provider**; judge accuracy at the underlying task
is not measured, and the one relevant benchmark suggests it would be modest for a
zero-shot model on text alone. Add R5's honest sentence. Also split "a removed
member loses access from the moment of removal" into the row-level (RLS) test and
the turn-level test — as written it asserts something the row-level test cannot
distinguish from a stale cache (§5.5).

### C9 — `ARCHITECTURE.md` §3 L117 — the idempotency step is narrower than it looks.

"idempotency check on `client_message_id` → duplicate? return existing turn"
handles a duplicate *message*. It does not handle a duplicate request arriving
after the message was persisted but before the reply was — the case where the
model call already succeeded and was already billed. R8 says this directly. The
diagram should either show the resume path or state that partial-turn recovery is
out of scope for v1; silently showing only the happy path is the version that
reads as an oversight. Related ordering fix in the same diagram: the `llm_calls`
row must be written **before** the model call, not after (§2, D-011).

### C10 — `ARCHITECTURE.md` §2 — a missing framing sentence, not an error.

Add: *`memory_items` is semantic memory in the CoALA sense; `messages` and
`agent_events` are the episodic layer it is built on top of.* No schema change
follows, but "is this episodic or semantic memory?" is an obvious interview
question and the answer is currently implicit.

### C11 — `README.md` L59 — "A set-containment check and an integer comparison." Imprecise.

The containment half is an anti-join (`NOT EXISTS` over `memory_audience` for
every active member of C2), not a single comparison. Cheap, yes; a single
comparison, no. Minor, but this line is doing rhetorical work and should be
accurate.

### Two things the research **confirms** are right, worth not "fixing"

- **`README.md` L154** — "The judge returns a verdict plus a one-line reason" is
  correct and is what R5 recommends. It is `config/agent.ts`'s
  `judgeSpeakThreshold: 0.7` that contradicts the README, not the other way
  round. Fix the config, not the prose.
- **`ARCHITECTURE.md` §3 / `README.md` L77–80** — filter-before-rank, with the
  filter in SQL and the rank in TypeScript. R3 §5 shows this is not merely a tidy
  split: it is what structurally avoids pgvector's post-filter ANN recall bug,
  and R16 finds the same ordering in Glean's published architecture. Strengthen
  the justification; do not touch the design.

---

## 7. One-line summary

The build can start. D-004, D-007 and D-009 are closed; D-011 is closed in shape
and open in its resume semantics; three new decisions (D-019, D-020, D-021)
should be written down before the code that assumes them. Before any of that,
correct the documentation — in particular the sentence saying
`ScopedAgentContext` *holds* the member set, which as written instructs an
implementer to build the very time-of-check/time-of-use gap the project's central
claim denies having.
