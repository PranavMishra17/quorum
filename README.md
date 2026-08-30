# Quorum

A multi-user chat workspace where a single AI agent is present in every
conversation, decides for itself whether it should speak, and learns about the
people it talks to — **without ever carrying what it learned across an
authorisation boundary.**

Built as a take-home for Moritz Legal. TypeScript end to end: Next.js on Vercel,
Postgres on Supabase.

> **Status: built, not yet deployed.** Auth, chats, the response gate, the turn
> pipeline, memory retrieval and extraction, and the agent internal view are all
> implemented, with ~300 assertions passing against a real PostgreSQL. What has
> not happened is a run against a provisioned Supabase project — so anything
> requiring live Google OAuth is written and type-checked but not yet *observed*
> working, and is not claimed as such. Live progress: [`PLAN.md`](PLAN.md).

---

## The problem the assignment hides

The brief says:

> *The agent learns useful information about users and can use it in future
> conversations.*

Implemented literally, that is a privacy leak.

Alice tells the agent something in a DM. The agent stores it against Alice.
Alice later speaks in a twelve-person group. The agent retrieves what it knows
about Alice — including the thing she said in confidence to a two-person
conversation — and uses it in front of eleven people who were never party to it.

Nothing in the requirement warns you about this. A naive `user_id → memories[]`
schema produces it by default, and the resulting demo looks like it works.

**Noticing this is most of the exercise.** The rest of this README is largely
about the rule that closes it.

## The surfacing rule

> A memory item learned in chat **C1** may surface in chat **C2** only if:
>
> 1. **Audience containment** — every active member of C2 was in the audience
>    snapshot taken when the item was learned. The audience may narrow, never
>    widen.
> 2. **Clearance floor** — C2's clearance level is **>=** the level recorded on
>    the item.
>
> Both conditions. Always. Evaluated in SQL, before ranking.

**Why condition 2 is not redundant.** The same set of people can share both a
level-3 *Internal Exec* group and a level-0 general group. Audience containment
alone is satisfied in both directions — so a fact learned in the exec channel
would be free to surface in the general channel. Clearance is the axis that
stops it. Membership answers *who*; clearance answers *in what capacity*.

Properties worth stating plainly:

- **It fails closed — but only because one case is handled explicitly.**
  "Every active member of C2 was in the audience snapshot" is *vacuously true*
  when C2 has no active members, in SQL (`NOT EXISTS`) and in JavaScript
  (`Array.every`) alike. Implemented naively, a fully vacated chat therefore
  passes containment for **every memory item in the system** — the exact leak
  this project exists to prevent, arriving through the front door of its own
  central rule. Zero active members returns zero items, asserted by a test.
- **It is cheap.** An anti-join over the audience snapshot plus an integer
  comparison — both indexed, both in the same query as the fetch.
- **It is testable.** The isolation tests below are the ones that prove the thesis.
- **The model never receives out-of-scope memory at all.** It cannot leak what
  it was never given. This is structural prevention, not a prompt asking the
  model to be discreet.

That last property is the thesis, and it holds — with one bound worth stating
plainly rather than burying. The audience half is *absolutely* structural:
`memory_audience` is immutable once written, so there is nothing to race. The
clearance half is **bounded, not absolute**: membership and clearance are live
state, and no design that keeps the model call outside a database transaction
can stop a response being generated from data that went stale mid-turn. The
guarantee is that a revocation takes effect on the **next privileged read**, not
that an in-flight turn is retroactively corrected. See
[D-009](docs/DECISIONS.md).

A second, more fundamental limit: item-level filtering does not defend against a
human aggregating two separately-authorised answers into a third, unauthorised
inference. No system surveyed claims to solve this.

### Retrieval order, and why the order is the design

In a twenty-person group, loading every member's memory is wrong on cost,
latency, and precision. Retrieval runs:

```
1. FILTER   audience containment + clearance floor  — in SQL, before anything else
2. RANK     lexical relevance (ts_rank), recency, speaker presence in recent turns
3. CAP      a global item budget AND a per-subject cap
4. LOG      retrieved count and filtered-out count -> agent_events
```

**Ranking is lexical, not semantic, and that is a deliberate cut.** Anthropic
ships no embeddings API, so semantic ranking would mean a second vendor, a second
key, and a re-embedding migration path — none of which the twelve-hour budget
justified for a candidate set that the authorisation filter has already reduced
to tens of items. `lib/memory/embed.ts` exists as an unimplemented interface so
the upgrade is a one-file change. The honest weakness: lexical matching misses
paraphrase, which in a legal product is exactly the gap embeddings exist to
close. See [D-004](docs/DECISIONS.md).

The critical property is that step 1 precedes step 2. Retrieving the top 20 by
relevance and then discarding the unauthorised ones is a different program with
the same output most of the time — and a leak the rest of the time.
Authorisation is not a relevance-ranking problem.

The per-subject cap in step 3 exists so one heavily-discussed person cannot
crowd out the other nineteen.

---

## Authorisation: two independent axes

Both must pass, on every read.

| Axis | Question | Mechanism |
|---|---|---|
| **Membership** | Is this user in this chat? | `chat_members.status = 'member'` |
| **Clearance** | Is this user badged for this kind of chat? | user's grants vs `chats.required_clearance_id` |

A gated group is unreachable by a user without **sufficient clearance level**,
regardless of any membership row. The axes are independent by construction,
which is exactly what makes the clearance floor meaningful in the memory rule.

The precision matters: clearance is a **monotone integer ladder** —
`general(0) / internal(1) / confidential(2) / restricted(3)` — so a user holding
a *higher* level satisfies a *lower* requirement without holding that specific
key.

The ladder measures exactly one thing: **how sensitive the material is.** An
earlier version had rungs named for teams (`external_audit`, `internal_exec`),
which quietly conflated two dimensions — a team name describes *who is in the
room*, not *how sensitive the content is* — and produced a real bug, where an
`internal` fact was eligible to surface into an `external_audit` chat purely
because 2 > 1. Teams are what `chat_members` models. See
[D-023](docs/DECISIONS.md).

The honest limit: real clearance systems are lattices, not ladders, so that
"Secret, Project A" does not imply "Secret, Project B". Quorum's ladder does not
model compartmentalisation and does not pretend to.

### Enforced at the data layer

Row-level security is on for **every** table, written in the same migration that
creates the table. The publishable Supabase key ships in the browser bundle; it
is only safe because RLS is what actually stops the query. Client-side checks
exist for UX and are never the sole guard.

Memory tables are stricter still: **no client access at all.** Postgres has no
"deny" policy — access is *granted* by at least one `PERMISSIVE` policy and
narrowed by `RESTRICTIVE` ones. So the construction is: RLS enabled, **no
permissive policy written at all**, and `SELECT`/`INSERT`/`UPDATE`/`DELETE`
revoked from `anon` and `authenticated`. With no policy to grant access, no row
is visible. Memory is reachable only through the server-side scoped path.

### The agent is the dangerous actor

The agent runs server-side and needs to read across chats to do its job. That
makes it the single most likely path to a leak, so it never holds an unscoped
service-role client in the request path.

`ScopedAgentContext` is constructed once per turn from a chat id. It fixes the
turn's **identity** — the chat, the acting user, the `turn_id` — and every agent
read of memory, files, or message history goes through it, applying both
authorisation axes in SQL before returning anything.

What it deliberately does **not** do is cache the member set or the clearance
level. An earlier draft of this document said it "resolves and holds" them, and
that was wrong in an instructive way: holding authorisation state across a
multi-second model call *is* the time-of-check/time-of-use gap. Membership and
clearance are therefore re-read, in SQL, at the moment of each privileged read.
This costs essentially nothing — every PostgREST call is already its own
transaction — and the alternative (wrapping a whole turn in one long
transaction) is worse on every axis: it holds a database connection open across
an external API call, and it fights connection pooling by design.

**A class is not a security boundary.** The honest version of this claim is four
layers, and only the middle two are enforcement:

1. *Convention* — one documented read path (`CLAUDE.md` non-negotiable #2).
2. **Application** — the context is the only place the service-role key is read.
3. **Database** — RLS means a bug in layer 2 still cannot cross a tenant.
4. *Tests* — a context built for chat A returns nothing belonging to chat B.

Layers 1 and 4 catch mistakes. Layer 3 is what survives them. If asked *"why RLS
when you already have application authorisation?"*: defence in depth —
application logic controls behaviour *intentionally*; RLS ensures an
unintentional bug does not become cross-tenant data access.

---

## When the agent speaks

The agent is present everywhere and must decide whether to respond. Hybrid:
a deterministic chain first, a model judge only for genuine ambiguity.

Evaluated in order, first match wins:

| # | Condition | Verdict |
|---|---|---|
| 1 | Sender is the agent itself | **silent** — loop guard, non-negotiable |
| 2 | Chat type is `agent` | **respond** — this is a direct conversation |
| 3 | Message mentions the agent | **respond** |
| 4 | Message replies to an agent message | **respond** |
| 5 | Two-human DM, agent not addressed | **silent** — present, but not a participant |
| 6 | Agent spoke within the cooldown, nothing new directed at it | **silent** |
| — | anything else | model judge |

The judge returns a verdict plus a one-line reason, and is **biased toward
silence**: an agent that stays quiet slightly too often is far better than one
that interjects constantly, and the failure modes are not symmetric. Judge
errors and timeouts also resolve to silence.

Every evaluation writes a `gate_evaluated` event carrying the verdict, which
rule fired, and the reason. Rate limiting sits above all of it.

## The agent internal view

Each chat exposes an append-only log of everything the agent did: gate decisions
and why, memory reads *including how many items the filter removed*, memory
writes, conflicts and how they resolved, tool calls and results, context dropped
for budget reasons, and token spend per call.

This is deliberately the most prominent feature after the chat itself. A memory
isolation rule you cannot see working is indistinguishable from one that does
not work.

## Tools and untrusted content

File and web tools put attacker-controlled text into the model's context. The
claim this project makes about that is deliberately narrow:

> Tool output — file contents, search results — is untrusted **data**. It reaches
> the model only inside a fenced, JSON-encoded `tool_result` block carrying
> explicit provenance, and **a turn that has ingested untrusted tool content
> cannot make a further externally-observable tool call outside a fixed
> allowlist resolved outside model control.** The fence raises the cost of an
> opportunistic attack; it is not a security boundary and is not claimed as one.
> The boundary is the privilege rule, because that one is enforced in code
> rather than in English.

The reason for the narrowness: when twelve published injection defences were
tested against *adaptive* attackers rather than static benchmarks, defences
reporting near-zero attack success rates fell above 90%, with prompting-based
defences — which is exactly what a delimiter is — at 95–99%. So "we are
protected against prompt injection" is not a sentence anyone can honestly write,
and it appears nowhere in this repository.

One consequence is specific to a system that *remembers*, and it is worth
stating because the general literature does not cover it. Extraction runs on the
model's own reply, so an injected instruction that makes the model assert a false
fact about a user would plant that lie into memory — correctly authorised,
surfacing indefinitely. Anything extracted from a turn that touched untrusted
content is therefore forced to `inferred` and below the confidence threshold, so
it lands as `candidate` and is never retrieved, while staying visible in the
internal view.

---

## Getting started

Requires Node 22+, pnpm 9+, a Supabase project, and an Anthropic API key.

```bash
pnpm install
cp .env.example .env.local   # then fill it in
pnpm dev
```

Filling in `.env.local`, in exact steps:

- **Supabase** — [`docs/SETUP-SUPABASE.md`](docs/SETUP-SUPABASE.md)
- **Vercel** — [`docs/SETUP-VERCEL.md`](docs/SETUP-VERCEL.md)

Model selection, thinking depth, cost tiers, gate thresholds, memory caps and
rate limits all live in [`config/`](config/) — not scattered through the code.

---

## Tests that matter

The brief asks for the tests *considered important*, not for coverage. These are
chosen so that each one defends a claim this README makes.

**Authorisation**
- A non-member cannot read a chat, its messages, its events, or its files.
- A member without sufficient clearance cannot read a clearance-gated chat.
- A removed member's next query returns nothing (row level, via RLS).
- A removal landing *mid-turn* takes effect on the agent's next privileged read
  (turn level). Split from the row-level case deliberately: one test alone
  cannot distinguish "access revoked" from "a cache that happens to be cold".
- A `requested` membership row grants no read access.
- A non-admin cannot add, remove, or promote members.

**Memory isolation — the tests that prove the thesis**
- An item learned in a DM does not surface in a group containing anyone outside
  that DM.
- An item learned in a level-3 chat does not surface in a level-0 chat with an
  *identical member set*.
- An item does surface in a chat whose members are a strict subset of the
  original audience.
- A user who joins a group *after* an item was learned neither causes that item
  to be excluded elsewhere, nor gains access to it.
- A `ScopedAgentContext` built for chat A returns nothing belonging to chat B.

**Agent behaviour** — against a stubbed provider, so the suite needs no API key
- The agent never responds to its own message.
- The agent responds when mentioned, and a mention overrides the cooldown.
- The cooldown suppresses a rapid second response.
- The judge is invoked *only* when the deterministic chain falls through.
- A judge error, timeout, or malformed verdict resolves to silence.

> These test the **pipeline** — which rule fired, and whether the fail-closed
> paths hold — not the judge's accuracy at deciding whether an unaddressed
> remark deserves a reply. That is a genuinely hard task, the one relevant
> benchmark suggests a zero-shot text-only model would be mediocre at it, and
> measuring it properly needs a labelled corpus this budget does not have. The
> honest claim is that the agent's *silence* is guaranteed by deterministic
> rules and its *speech* is a judgement call that is logged and inspectable.

**Memory lifecycle**
- A directly stated fact supersedes a conflicting inferred fact.
- A superseded item is not retrieved.
- A candidate item below the confidence threshold is not retrieved.

**Tools**
- A file uploaded in chat A is not retrievable from chat B.

---

## Assumptions

Recorded because each one is a defensible reading of an under-specified
requirement, not because each one is obviously correct.

1. **An `agent` chat type exists with a single human member.** This extends the
   stated minimum of two users per chat. It exists so the agent can be addressed
   directly with different gate behaviour.
2. **Removed members lose access to history on their next read.** The
   Slack-style alternative — retaining previously visible history — is equally
   defensible; the stricter reading was chosen deliberately.

   "Next read", not "the moment of removal", and the difference is not
   pedantry. Supabase Realtime evaluates RLS when a subscription is established
   and caches that result for the socket's lifetime, so a removed member
   holding an **already-open subscription** would keep receiving new messages
   until the socket dropped.

   Removal now broadcasts a revocation to that user, and their client tears
   down its subscriptions on receipt — which narrows the window from "until the
   socket drops" to "within a round trip". It is worth being precise about what
   that is: **cooperative, not enforcement.** The teardown runs in the browser
   being revoked, so a modified client could ignore it and keep receiving new
   messages on that one channel until the socket closed. Every other read —
   history, roster, files, memory — is refused immediately by RLS. Closing the
   window properly needs server-side socket termination, which Supabase does
   not currently expose. Hence the guarantee stated here is the honest one:
   **access ends on the next read.**
3. **Memory audience is a snapshot at learn time, not current membership.**
   Someone who joins later was not present when the thing was said.
4. **Memory visibility never widens automatically.** Broadening requires an
   explicit act by the subject.
5. **Clearances are an integer level plus a named key, measuring sensitivity
   only** — enough to demonstrate the authorisation axis without modelling a real
   entitlement system. Not a lattice; no compartmentalisation.
6. **Google is the only auth provider.** Authentication was explicitly permitted
   to be simplified; authorisation is where the effort went.
7. **The gate biases toward silence when uncertain.**

## Tradeoffs and what comes next

To be written against the finished build, from the running log in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

Known deliberate cuts so far:

- **No knowledge graph.** `memory_nodes` / `memory_edges` were designed and then
  cut, and the cut was tested rather than assumed. The bar set was: *name three
  product queries a graph answers well and a flat relational table answers
  badly.* One turned out to be answered **better** without a graph (single-hop
  subject lookup — Mem0's own benchmark). One is real but is not a requirement of
  this product (multi-hop provenance). One — temporal "how did this change" — is
  genuinely where graphs win in the literature, and Quorum already answers it
  relationally through the `superseded_by` chain. Looking for three and finding
  one and a half is the argument for cutting.
  **Reopen triggers, stated so the decision is falsifiable:** a product
  requirement for branching provenance (a fact derived from two others, which
  `superseded_by` cannot express), or a "trace this instruction back to who
  authorised it" feature — plausible for a legal product.
- **Gmail integration** is the first thing dropped if time runs short.
- **The force-directed space view is scheduled last on purpose.** It is the most
  visually impressive piece and the least graded; a conventional list view ships
  first and remains the fallback.

## On AI tooling

How AI tools were used, which parts were generated versus hand-written, and how
the output was checked: [`docs/AI-USAGE.md`](docs/AI-USAGE.md), kept as a running
log rather than reconstructed at the end.
