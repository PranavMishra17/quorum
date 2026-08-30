# R14 — Postgres transactions and isolation

**Band:** C · **Closes:** informs D-009, D-011 · **Status:** complete

## Question

Quorum's data layer (`lib/db/scoped-agent.ts`, `lib/memory/retrieve.ts`) makes
several reads and writes per agent turn under RLS, through Supabase's
PostgREST/Supavisor stack rather than a raw persistent connection. D-009 (does
membership-change mid-turn leak into what the agent sees) and D-011 (does a
retried turn write memory twice) both cash out as Postgres transaction and
concurrency-control questions. This track needed a working, correct vocabulary
for isolation levels, serialization failures, advisory locks, and row locks —
and, more specifically, what of that is even reachable through Supabase's
default JS-client / PostgREST path, since a naive assumption ("just wrap it in
a transaction") does not hold there.

## Findings

1. **Isolation levels and what each permits.** Postgres implements three
   levels (Read Uncommitted is aliased to Read Committed): Read Committed
   (default) permits nonrepeatable reads, phantom reads, and serialization
   anomalies but never dirty reads; Repeatable Read additionally prevents
   nonrepeatable and phantom reads (Postgres's Repeatable Read is stronger
   than the SQL standard's — it blocks phantoms too) but still permits
   serialization anomalies; Serializable prevents all of the above via
   predicate locking (SIReadLock), monitoring read/write dependencies rather
   than just row conflicts. [postgresql.org/docs/current/transaction-iso.html]

2. **Serialization failures and retry.** Repeatable Read and Serializable can
   both abort a transaction with SQLSTATE `40001` — `could not serialize
   access due to concurrent update` (Repeatable Read) or `...due to
   read/write dependencies among transactions` (Serializable). Read Committed
   never does this; it silently re-reads the latest committed row instead.
   The documented pattern is a retry loop keyed on catching `40001`
   specifically and retrying the *whole* transaction, not just the failed
   statement — a read-only transaction never gets `40001`, so retry logic
   only needs to wrap write paths. [postgresql.org/docs/current/transaction-iso.html]

3. **Advisory locks.** Application-defined, not enforced by Postgres itself —
   correctness depends entirely on every caller actually taking the lock.
   Session-level locks (`pg_advisory_lock`) survive rollback and need an
   explicit unlock or session end; transaction-level locks
   (`pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`) release automatically
   at commit/rollback, which is the shape that fits a single Postgres function
   invoked per request. The non-blocking `pg_try_advisory_xact_lock` returning
   `false` is the idiomatic "someone else is already processing this" guard.
   [postgresql.org/docs/current/explicit-locking.html]

4. **`SELECT ... FOR UPDATE` / row-level locking.** Blocks other writers and
   lockers on the same row (not plain readers), released at transaction end.
   `FOR UPDATE` is exclusive; `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY
   SHARE` are progressively weaker and let non-conflicting operations
   proceed concurrently. Deadlocks between two `FOR UPDATE` transactions
   locking two rows in opposite order are detected automatically by Postgres
   (one transaction is aborted); the standard mitigation is a fixed lock
   acquisition order across all call sites, not a Postgres feature.
   [postgresql.org/docs/current/explicit-locking.html]

5. **The Supabase-specific catch: PostgREST/supabase-js gives you none of
   this by default.** `supabase-js` has no multi-statement transaction API —
   each PostgREST request is its own implicit transaction, and there is no
   client-side `BEGIN`/`COMMIT` across two `.from()` calls. The documented
   workaround for anything that must be transactional (multiple statements,
   an explicit isolation level, an advisory lock, a `FOR UPDATE`) is a
   Postgres function (`SECURITY DEFINER` or `INVOKER`) invoked via
   `supabase.rpc(...)`, because the function body runs as one transaction on
   the server. This is corroborated by Supabase's own connection-pooling
   docs: Supavisor's **transaction mode** — the mode Supabase recommends for
   serverless/edge-function traffic, which is what Quorum's Next.js API
   routes are — explicitly shares one physical connection across many
   logical client requests between transactions, so session-level state
   (session advisory locks, prepared statements, `SET` outside a
   transaction) cannot be relied on to survive between two separate
   `supabase-js` calls even on the same "connection" as seen by the app.
   [supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO,
   supabase.com/docs/guides/database/connecting-to-postgres,
   supabase.com/docs/reference/javascript/rpc]

   **Uncertain / not verified primary-source-first:** the specific default
   isolation level PostgREST opens each request's implicit transaction at —
   I did not find and fetch PostgREST's own source/docs confirming this is
   Read Committed (it is the Postgres default and I have not seen anything
   suggesting PostgREST overrides it, but this finding rests on absence of a
   contrary statement, not a direct citation of PostgREST's transaction
   setup code). This should be verified against PostgREST's docs
   (postgrest.org) before it becomes a load-bearing README claim.

## Application to Quorum

- **`lib/db/scoped-agent.ts`** is the one file with service-role access
  (non-negotiable #2). Any point in an agent turn that needs more than
  Read-Committed guarantees — e.g., "read memory audience snapshot + write a
  new memory item without another concurrent write changing the audience
  underneath it," or D-011's "don't write two `agent_events`/memory rows for
  a retried turn" — cannot be done by issuing two separate calls through
  `supabase-js` and hoping they land in one transaction. They don't; per
  Finding 5, each is its own PostgREST transaction. The correct construct is
  a Postgres function (e.g. `process_agent_turn(turn_id, ...)`) called once
  via `.rpc()` from `scoped-agent.ts`, with the whole multi-step body inside
  it — this keeps "one file reads the service-role key" true while still
  getting real transactional semantics, because the function itself runs
  server-side in a single transaction regardless of pooler mode.
- **D-011 (idempotency)** is better closed with the unique-constraint
  approach already leaning in `docs/DECISIONS.md` — `UNIQUE (chat_id,
  client_message_id)` — checked via `INSERT ... ON CONFLICT DO NOTHING`
  inside that same RPC function, rather than an advisory lock. An advisory
  lock (`pg_try_advisory_xact_lock(hash(chat_id, client_message_id))`) is a
  reasonable *additional* guard against two concurrent requests racing before
  either has inserted the row, but per Finding 5's pooler warning, this must
  be a `pg_try_advisory_xact_lock` (transaction-scoped, auto-released) taken
  inside the RPC function — never `pg_advisory_lock` from application code
  outside a transaction, because Supavisor transaction mode does not
  guarantee the JS client keeps the same physical connection to unlock it.
- **D-009 (mid-turn membership change)** — Repeatable Read is the right
  isolation level for the RPC function backing a turn if option (a) or (c)
  from `docs/DECISIONS.md` is chosen: opening the function body with `SET
  TRANSACTION ISOLATION LEVEL REPEATABLE READ` gives the whole turn one
  consistent snapshot of `chat_members` and `memory_audience`, so a removal
  mid-turn cannot partially apply. This directly answers D-009 option (c)
  ("run the turn in a single transaction at a defined isolation level") and
  should be the recorded resolution, contingent on R2's fuller answer.
  `config/agent.ts` is the right place for a named constant if a specific
  isolation level or lock-timeout value becomes load-bearing (non-negotiable
  #8 — no magic numbers outside `config/`).
- **`lib/memory/retrieve.ts`** (filter → rank → cap) does not need
  Serializable — it is read-only, and per Finding 2, read-only transactions
  never hit `40001`. Read Committed (Postgres/Supabase default) is sufficient
  there; reserve Repeatable Read/Serializable for the write paths that touch
  `memory_audience` and `agent_events`.

## Recommendation

This closes no D-0xx on its own (it is Band C, explicitly informational per
`research/RESEARCH.md`), but it directly informs **D-009**. The option it
supports is **D-009(c) run the turn in a single transaction at a defined
isolation level**, implemented as a Postgres RPC function called once from
`lib/db/scoped-agent.ts`, opened at `REPEATABLE READ`.

**Strongest argument against this option, stated fairly:** Repeatable Read
buys consistency at the cost of introducing serialization failures
(`40001`) that Read Committed never produces — every write path through that
RPC function now needs a retry loop, which is real complexity in a codebase
that has none yet, and a naive implementation of D-011's idempotency
(unique-constraint insert) could itself trigger spurious serialization
failures under concurrent retries of the *same* turn, which then need careful
handling so a legitimate retry isn't mistaken for a conflict. Option (a) —
snapshot at turn start, accept staleness, no isolation-level change — is
simpler, has no retry-loop cost, and may be good enough given Quorum's
threat model already treats membership as narrowing-only and a few-second
staleness window is a much smaller leak than the audience-snapshot leak the
whole project is built to close. The isolation-level route should not be
adopted over option (a) without R2's fuller analysis of how much staleness
is actually tolerable.

**What would settle it:** R2's answer (this track's sub-questions were
explicitly scoped as "partly subsumed by R2"), plus a direct check of
PostgREST's own transaction-per-request documentation (postgrest.org) to
confirm the default isolation level assumption in Finding 5 rather than
inferring it from absence of a contrary statement.

## Sources

- [PostgreSQL 17 Docs — 13.2. Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — isolation levels, anomalies table, SQLSTATE 40001, retry pattern, predicate locking.
- [PostgreSQL 17 Docs — 13.3. Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — advisory locks (session vs. transaction scope), row-level lock modes, deadlock detection.
- [Supabase Docs — Supavisor and Connection Terminology Explained](https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO) — transaction-mode pooling behavior, why session state doesn't survive across client calls.
- [Supabase Docs — Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres) — recommended pooler mode for serverless/edge traffic.
- [Supabase Docs — JavaScript: rpc](https://supabase.com/docs/reference/javascript/rpc) — RPC as the mechanism for server-side multi-statement/transactional logic from supabase-js.
