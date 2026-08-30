# R2 — Authorisation consistency under concurrency (TOCTOU)

**Band:** A · **Closes:** D-009 · **Status:** complete

## Question

An agent turn is not instantaneous — it spans a gate check, a memory
retrieval, a model call (network round trip, seconds), an optional tool loop,
and a persist step. Chat membership can change inside that window (an admin
removes a user mid-turn). `docs/DECISIONS.md` states the problem plainly:

```
t+0s  turn starts, member set resolved
t+2s  admin removes User A
t+3s  memory retrieval runs
```

This is a textbook time-of-check/time-of-use (TOCTOU) shape, and "what happens
if membership changes mid-turn?" is an obvious line of attack on Quorum's
design. D-009 needs a stated, defensible consistency model — not an accident
of whatever `ScopedAgentContext` happens to do — because the README's central
claim (structural, not probabilistic, prevention of memory leaks) is weakened
if the *membership* half of the authorisation check can silently run on stale
data while the *audience-snapshot* half is airtight by construction.

## Findings

**1. Where the check and the use actually are, and how far apart.**
`docs/ARCHITECTURE.md` §3 shows the pipeline: `ScopedAgentContext(chat_id)` is
built once, early, and — per §1 — "resolves **and holds** the chat's active
member set, its clearance level, and the requesting user." That "holds" is
the check. The uses are every subsequent read through that context: memory
retrieval, message history, tool execution, and (implicitly) the decision to
even proceed with the turn. Concretely, per `docs/ARCHITECTURE.md` §3, the gap
between check and the *last* use is the model call plus an optional bounded
tool loop — i.e., low single-digit seconds in the common case, but not
bounded above, since it depends on an external API (Anthropic) and Vercel's
function time limit (research track R9), not on anything Quorum controls.
CWE-367 (MITRE's canonical TOCTOU entry) does not require a minimum gap for
exploitability — "the document does not specify a minimum time gap... latency
... can create vulnerability windows" — so the fact that this gap is usually
short does not make it not-a-TOCTOU; it only bounds the blast radius.
[cwe.mitre.org/data/definitions/367.html]

**2. What `REPEATABLE READ` in one transaction actually buys, and its real
cost here.** Postgres's `REPEATABLE READ` is snapshot isolation: "the
Repeatable Read isolation level only sees data committed before the
transaction began; it never sees... changes committed by concurrent
transactions during the transaction's execution," and this snapshot is
established "at the start of the first non-transaction-control statement,"
held for every statement thereafter. It has essentially no extra locking cost
over Read Committed for pure reads, but write paths inside it can fail with
`could not serialize access due to concurrent update` (SQLSTATE `40001`) and
must be retried from the top; read-only transactions are exempt from this.
[postgresql.org/docs/current/transaction-iso.html]

That is the *isolation-level* cost. There is a separate, larger cost specific
to Quorum's shape: an agent turn is not a burst of DB statements — it
contains an outbound network call to the model provider that can take
seconds. Wrapping check-through-use in one open transaction means holding a
transaction (and, in a pooled setup, a physical server connection) open for
the *entire* duration of that external call. This is a named anti-pattern
independent of Postgres specifics: "database transactions... consume valuable
resources (connections, memory, CPU). External API calls introduce
unpredictable network latency... the database doesn't 'know' the connection
is waiting on an external service... the connection remains occupied," with
the standard remediation being to "never make external API calls while
holding a DB connection." [medium.com/@eshikashah2001, "Making API Calls
within a Transaction Boundary: A Practice to Avoid" — vendor-blog tier, cited
for the pattern name only, not as sole authority; corroborated independently
by finding 7 below on what Supavisor's pooling model is actually optimized
for.]

**3. Snapshot-at-start vs. re-check-per-read: what comparable systems do, and
what the stack does by default regardless.** No system surveyed holds one
open transactional snapshot across a multi-second, externally-dependent
workflow to answer several authorisation questions:

- **OWASP's Authorization Cheat Sheet** states the general web-application
  norm directly: perform "access control checks... on every request for the
  specific object or functionality being accessed," not once per session and
  reused. [cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html]
- **Google Zanzibar** (Google's production authorization system, USENIX ATC
  '19) re-evaluates per check rather than reusing one long-lived snapshot; its
  "zookie" tokens give "at-least-as-fresh" semantics — a check may be
  answered from data *fresher* than requested, never staler — and it
  explicitly rejects the fully-synchronous alternative: "such evaluation
  would require global data synchronization with high-latency round trips and
  limited availability." [usenix.org/system/files/atc19-pang.pdf via
  authzed.com/zanzibar, which annotates and quotes the paper directly]
- **AWS IAM and Google Cloud IAM** (below) are both re-checked per API call
  against whatever state has propagated so far — they do not offer a
  "snapshot the whole session" mode at all; consistency is handled entirely
  on the write/propagation side, not by pinning reads.

Separately, and specific to Quorum's actual stack: Supabase's `supabase-js`
client talks to Postgres through PostgREST, and **each PostgREST request is
its own implicit transaction** — there is no client-side `BEGIN`/`COMMIT`
spanning two `.from()` calls (confirmed in this project's own R14 finding 5,
citing supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO
and supabase.com/docs/guides/database/connecting-to-postgres). This means
"re-check at time of use" is not an extra feature Quorum has to build — it is
what happens by default unless a bespoke Postgres RPC function is written to
force multiple steps into one transaction. The work is in the *opposite*
direction from what D-009's candidate (c) implies: holding one snapshot
across the turn is the thing that would require extra engineering (a wrapping
RPC function held open across the model call), not the reverse.

**4. Revocation latency: what a defensible bound looks like in practice.**
Neither hyperscale IAM system promises anything close to immediate:
- **AWS IAM** states plainly, in its own troubleshooting docs, that it "uses
  a distributed computing model called eventual consistency... changes... take
  time to become visible from all possible endpoints... you must design your
  global applications to account for these potential delays."
  [docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot.html] Independent
  measurement (not authoritative, orientation only) puts common cases around
  3–10 seconds, occasionally longer.
- **Google Cloud IAM** publishes actual numbers: role-binding changes
  "typically 2 minutes, potentially 7 minutes or longer"; group-membership
  changes "typically several minutes, potentially hours or longer" — and it
  explicitly states the asymmetry that matters most here: **"adding a
  principal to a group propagates faster than removing a principal from a
  group."** [docs.cloud.google.com/iam/docs/access-change-propagation]
- **Zanzibar's "new enemy problem"** is the canonical name for getting this
  wrong: "Alice removes Bob from the ACL of a document; Alice then asks
  Charlie to add new contents to the document; Bob should not be able to see
  the new contents, but may do so if the ACL check is evaluated with a stale
  ACL." [authzed.com/zanzibar, quoting the paper]

Given that AWS and Google — with dedicated global infrastructure for exactly
this problem — only commit to minutes-to-hours bounds and explicitly refuse a
tighter SLA, "authorisation is evaluated at turn start; a removal takes
effect from the next turn" (D-009's framing) would already be a *stronger*
published guarantee than either of them state, since Quorum's turns run for
single-digit seconds. But finding 3 shows Quorum can do better than that
framing implies, essentially for free — see Recommendation.

**5. Does the removal write itself need to be transactional with anything
else?** The removal (`UPDATE chat_members SET status = 'removed', removed_at
= now() WHERE ...`) is a single SQL statement. In Postgres, a single statement
not otherwise inside `BEGIN...COMMIT` runs in its own implicit transaction and
is atomic by construction — nothing extra is needed for the row-level write
to be all-or-nothing. [This is basic Postgres transaction semantics,
consistent with the transaction-isolation docs above; not separately
citation-worthy beyond postgresql.org/docs/current/transaction-iso.html.]
Where atomicity *does* start to matter is if the removal should also,
inseparably, write an audit trail row (`agent_events`) — e.g. "member X was
removed by admin Y" — so the internal view can never show a removal that
silently failed to log. That is a short, DB-only, no-external-call operation,
which is exactly the case R14 correctly recommends a Postgres RPC function
for (`SECURITY DEFINER`/`INVOKER`, called via `.rpc()`, one physical
transaction regardless of pooler mode). It is not, however, a case for
wrapping the *whole agent turn* in a transaction — see Recommendation for why
those two are different questions that R14 partially conflates.

**6. What the audience-snapshot design already removes, and what it does
not.** `memory_audience` is written once, at learn time, and is never
re-evaluated against current membership (D-006) — so the *learn-time* half of
the surfacing rule (`the audience the item was learned into`) is immutable
and has no TOCTOU surface at all; there is nothing to race against because
nothing about it changes after it's written. What remains live and mutable is
the *other* half of the rule: "every active member of **C2**" (the chat where
retrieval is happening *now*) and C2's current clearance requirement. That
membership check is a fresh read against `chat_members`/`user_clearances` at
retrieval time — which is precisely the TOCTOU surface D-009 is about. So the
design removes roughly half the problem by construction (the C1 side) and
leaves the other half (the C2 side, and the "is the turn's own audience still
who we think it is" question) as a live, ordinary read-time authorisation
check — which finding 3 shows is already how PostgREST calls behave by
default.

**7. Connection pooling interaction (Supavisor/PgBouncer transaction mode).**
Supabase explicitly recommends **pooler transaction mode** for
"serverless or edge functions" traffic — i.e., Quorum's Vercel API routes.
[supabase.com/docs/guides/database/connecting-to-postgres] In PgBouncer-style
transaction pooling, "a server connection is assigned to a client when it
begins a transaction, and released... when the client's transaction
completes" — the whole design point is that connections are held only for
the length of one short transaction and returned immediately, which is what
lets a small pool serve many concurrent serverless invocations. Session-level
state (prepared statements, `SET` outside an explicit transaction, session
advisory locks) does **not** reliably survive between separate calls in this
mode; Supabase's own troubleshooting docs confirm transaction mode "does not
support prepared statements" for this reason, and R14 draws the same
conclusion for advisory locks (session-scoped locks must not be relied on;
transaction-scoped `pg_try_advisory_xact_lock` is the only safe form).
Two consequences for D-009 specifically: (a) trying to hold one open
transaction for an entire agent turn works directly against what
transaction-mode pooling is built for — it would tie up a pooled connection
for the length of an LLM call, at a multiple of the cost of the short reads
the pool is sized for; (b) there is no session-level trick (a cached
membership set held in a variable, a session-scoped lock) that survives
across the separate PostgREST calls a turn actually makes, which reinforces
finding 3's conclusion that "re-check per call" is the stack's native
behaviour, not an opt-in extra.

## Application to Quorum

- **`lib/db/scoped-agent.ts`** — `ScopedAgentContext` should **not** cache
  the chat's member set and clearance level as instance fields fetched once
  at construction and reused for the rest of the turn, despite
  `docs/ARCHITECTURE.md` §1 currently saying it "resolves and holds" them.
  That phrasing should be edited (see below). Concretely: expose methods
  (e.g. `isActiveMember(userId)`, `clearanceLevel()`) that issue a fresh,
  indexed query (`chat_members(chat_id, status)` — already in the planned
  index list in `docs/ARCHITECTURE.md` §2) each time they are called, rather
  than fields populated once. Given finding 3, this is close to free: each
  PostgREST call the context makes is already its own transaction, so there
  is no transactional machinery to add — only a discipline not to hold a
  value in memory across the model call and reuse it. The one thing that is
  legitimately fixed at construction is *identity* — which chat, which
  triggering user, which `turn_id` — because that does not change mid-turn
  and is not itself a privileged read.
- **`lib/memory/retrieve.ts`** — the filter step (containment + clearance,
  evaluated in SQL, per README) must query current `chat_members` and
  `user_clearances` live at call time, not receive a membership set handed
  down from `ScopedAgentContext`'s construction. This is finding 6's C2 side
  of the rule, and it is the one part of the surfacing rule that is not
  already immutable by the `memory_audience` snapshot.
- **`api/agent/turn/route.ts` / `lib/agent/orchestrator.ts`** — do **not**
  wrap gate → retrieve → model call → tool loop → persist in one Postgres
  transaction or one `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` RPC
  function held open across the model call. That is D-009's candidate (c),
  and findings 2 and 7 show it is both infeasible without deliberately
  fighting the PostgREST/Supavisor stack and actively harmful (an anti-
  pattern) if built anyway, since it holds a pooled connection open across an
  external network call in a pooling mode specifically sized against that.
- **Where R14's REPEATABLE-READ-RPC recommendation is still correct**: for
  short, DB-only, no-external-call multi-statement operations that need real
  atomicity — the idempotent message insert for D-011
  (`INSERT ... ON CONFLICT DO NOTHING` on `messages(chat_id,
  client_message_id)`), and an atomic `memory_items` + `memory_audience`
  insert pair at extraction time (D-013/D-006). Those belong in Postgres
  functions called via `.rpc()`, exactly as R14 describes. **They are a
  different question from D-009** — R14's finding 5 example ("write a new
  memory item without a concurrent write changing the audience underneath
  it") is about write-time atomicity of a fast DB-only operation, not about
  whether an entire multi-second agent turn should be one read snapshot. R2
  narrows R14's D-009 lean rather than contradicting its RPC-transaction
  recommendation in general.
- **`docs/DECISIONS.md` D-009** — should move from OPEN to settled with the
  sentence in the Recommendation below, replacing candidate (a)'s
  "next-turn" framing with the tighter "next privileged read" framing that
  finding 3 shows is achievable by default.
- **`docs/ARCHITECTURE.md` §1** — the line "resolves and holds the chat's
  active member set, its clearance level, and the requesting user" should be
  corrected: it resolves the requesting user and chat identity once, but
  member set and clearance are read fresh per privileged call, not held.
- **Tests** — `tests/authorization/membership.test.ts` currently has
  `it.todo('a removed member loses access from the moment of removal')` at
  the row-read (RLS) level. This track's finding motivates a second,
  turn-shaped version of that test, closer to
  `tests/agent/gate.test.ts` or a new integration test: construct one
  `ScopedAgentContext`, remove the member via a second connection between two
  calls made through *that same context instance*, and assert the second
  call denies — proving re-check-per-call rather than a construction-time
  cache, which a pure RLS-level test cannot distinguish from a cached
  snapshot that happens to still be correct because the test didn't wait
  long enough.

## Recommendation

**Closes D-009.** The option chosen is a refinement of candidate (a)
("snapshot at turn start, accept staleness") rather than candidate (c) ("run
the turn in a single transaction at a defined isolation level"), stated
precisely as:

> Turn *identity* (chat, acting user, `turn_id`) is fixed once at turn start.
> Every privileged read of mutable authorisation state — membership,
> clearance, and the memory-audience containment check — is evaluated fresh,
> in SQL, at the moment that specific read runs, in its own request-scoped
> transaction. A membership or clearance change takes effect on the very next
> privileged read within the same turn, not merely "the next turn." What
> cannot be undone is a response already generated from data read *before*
> the change — no design that keeps the model call outside a database
> transaction can close that residual gap, and Quorum should say so rather
> than imply otherwise.

This is achievable essentially for free because (finding 3) it is what the
PostgREST/Supavisor stack already does by default — the discipline required
is *not* caching `ScopedAgentContext`'s member/clearance data across the
model call, not adding new machinery.

**Strongest argument against this option, stated fairly.** Re-checking
per-read is weaker than it sounds in one specific way: it only shrinks the
TOCTOU window, it does not close it. If the last privileged read happens at
t+2.9s and removal lands at t+3.0s, the model still generates its response
from data that is now stale, and that response is delivered anyway — "next
read" is not "no window," it is "smallest practical window given the
constraint that the model call itself cannot be transactional." A reviewer
could reasonably ask why this is acceptable, and the honest answer is: it is
the same answer AWS and Google give (finding 4) at a much tighter bound, and
the alternative (candidate (c)) does not actually close the window either —
it would need the *entire* turn, model call included, inside one open
transaction to guarantee the model never acts on data that becomes stale
mid-turn, which finding 2 shows is a documented anti-pattern regardless of
Postgres semantics. There is no design in this stack that gets true
atomicity across an LLM call; the honest claim is a bound, not a guarantee,
and this report's recommendation states the tightest bound that's actually
free to implement rather than a false zero.

A second, narrower argument against per-read re-checking specifically: it is
a deviation from what `docs/ARCHITECTURE.md` currently describes (a
context that "holds" its resolved state), so it costs a documentation
correction and a slightly less simple mental model ("this method hits the DB
every call" vs. "this object is a snapshot") for a benefit — shrinking a
window that is already single-digit seconds — that is modest in absolute
terms. Given Quorum's actual scale (a take-home, not a multi-region system),
either framing would likely pass review; this report recommends the
free-and-tighter one because it costs nothing to implement correctly and
because the README's central claim is about structural rather than
probabilistic prevention, which the tighter bound is more consistent with.

**What would fully settle the residual gap** (a response generated from
data that goes stale before the response is delivered): nothing available in
this stack without either (a) making the model call itself resumable/
cancellable on a mid-flight revocation — real complexity, not proportionate
here — or (b) accepting the bound stated above and documenting it, which is
what this report recommends.

## Sources

- [PostgreSQL 17 Docs — 13.2. Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — snapshot semantics, Repeatable Read guarantees and limits, SQLSTATE 40001 retry pattern.
- [CWE-367 — Time-of-check Time-of-use (TOCTOU) Race Condition](https://cwe.mitre.org/data/definitions/367.html) — MITRE's canonical definition and mitigation catalogue.
- [OWASP Cheat Sheet Series — Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — per-request re-evaluation as the general web norm.
- [Zanzibar: Google's Consistent, Global Authorization System (USENIX ATC '19)](https://www.usenix.org/system/files/atc19-pang.pdf), annotated/quoted via [authzed.com/zanzibar](https://authzed.com/zanzibar) — zookies, at-least-as-fresh semantics, the "new enemy problem," the explicit rejection of full global synchronization.
- [AWS IAM — Troubleshoot IAM (official docs)](https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot.html) — IAM's own statement of eventual consistency and its cause.
- [Google Cloud IAM — Access change propagation (official docs)](https://docs.cloud.google.com/iam/docs/access-change-propagation) — published propagation bounds for role bindings and group membership, and the grant-faster-than-revoke asymmetry.
- [Supabase Docs — Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres) — transaction-mode pooling recommended for serverless/edge traffic.
- [Supabase Docs — Supavisor and Connection Terminology Explained](https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO) — one PostgREST request = one implicit transaction; session state does not survive across client calls.
- [Supavisor FAQ](https://supabase.github.io/supavisor/faq/) — transaction mode does not support prepared statements; session vs. transaction mode feature differences.
- PgBouncer transaction-pooling behaviour (server connection assigned for the duration of one transaction, released at commit) — corroborated across multiple pooling explainers (e.g. [pgbouncer.org/features.html](https://www.pgbouncer.org/features.html), [Heroku Dev Center — PgBouncer Configuration and Best Practices](https://devcenter.heroku.com/articles/best-practices-pgbouncer-configuration)); orientation-tier, not treated as sole authority — the load-bearing claim (transaction mode's design intent) is corroborated by the Supabase docs above.
- "Making API Calls within a Transaction Boundary: A Practice to Avoid" (Medium) — vendor/blog tier, cited only for naming the anti-pattern of holding a DB transaction open across an external network call; not used as sole authority for any claim in this report — the underlying mechanism (pooled connection held for transaction duration) is independently confirmed by the PgBouncer/Supavisor sources above.
- This project's own [`research/reports/R14-postgres-transactions.md`](R14-postgres-transactions.md) — Band C, informational, explicitly flagged as "contingent on R2's fuller answer" for D-009; this report narrows R14's lean toward candidate (c) to short DB-only RPC operations (D-011 idempotency, atomic memory+audience writes) and recommends against applying it to the whole agent turn.
