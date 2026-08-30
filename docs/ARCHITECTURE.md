# Architecture

High-level design and the file-by-file fan-out. Written before implementation so
that the shape is argued about once, in one place, rather than emerging by
accident.

Status: **Phase 1 built, Phase 2 starting.** Live progress per item is in
[PLAN.md](../PLAN.md); this document describes the shape, not the state. Where
implementation diverged from what was designed here, the divergence is recorded
inline rather than quietly conformed to.

---

## 1. Shape of the system

```
Browser
  │  Supabase JS (publishable key) — reads go direct, RLS is the guard
  │  fetch() — writes and all agent work go through route handlers
  ▼
Next.js App Router  (Vercel)
  ├── (marketing)          public landing
  ├── (app)                authenticated surfaces
  └── api/                 route handlers — the only writers
        │
        ├── lib/db/server.ts        session-bound client, RLS applies
        └── lib/db/scoped-agent.ts  ← the ONLY service-role site
              │
              └── agent turn pipeline
                    gate → retrieve → assemble → model → tools → persist → extract
  ▼
Supabase Postgres  (RLS on every table)  +  Storage  +  Google auth
```

Two clients, two trust levels, and the boundary between them is a single file.

**Why reads can go direct from the browser.** RLS makes the publishable key
safe: the database itself refuses rows the user may not see. This removes a
whole layer of hand-written read endpoints, and — more importantly — makes the
database the thing that has to be right, rather than every endpoint.

**Why writes do not.** Writes need the agent pipeline, idempotency, rate
limiting, and event logging. None of that belongs in the client.

---

## 2. Data model

```
profiles              id (= auth.users.id), display_name, avatar_url, color, created_at
clearances            id, key, name, level int, description
user_clearances       user_id, clearance_id, granted_at, granted_by
chats                 id, type ('dm'|'group'|'agent'), name, created_by,
                      required_clearance_id nullable, created_at
chat_members          chat_id, user_id, role ('admin'|'member'),
                      status ('member'|'requested'|'invited'|'removed'),
                      joined_at, removed_at
messages              id, chat_id, sender_type ('user'|'agent'), sender_id nullable,
                      content, client_message_id (idempotency), turn_id, created_at
memory_items          id, subject_user_id, origin_chat_id, origin_message_id,
                      content, search_vector tsvector, clearance_level int,
                      source_type ('stated'|'inferred'), confidence,
                      status ('candidate'|'active'|'superseded'|'stale'),
                      superseded_by, created_at, expires_at
memory_audience       memory_item_id, user_id          ← the critical table
agent_events          id, chat_id, turn_id, request_id, message_id nullable,
                      event_type, payload jsonb, created_at
llm_calls             id, chat_id, turn_id, request_id, message_id,
                      model, tier, purpose, status ('started'|'succeeded'|'failed'),
                      input_tokens, output_tokens, cost_estimate,
                      started_at, finished_at, created_at
files                 id, chat_id, uploader_id, storage_path, filename,
                      mime_type, size_bytes, created_at
```

**`memory_audience` is the table that makes the thesis work.** It snapshots
exactly who was an active member of the originating chat at the instant the item
was learned. Containment is evaluated against that snapshot and never against
current membership — because membership changes, and someone who joined a group
in March was not in the room in January.

**`agent_events.payload` is jsonb on purpose.** A new event type is a new
`event_type` string and a new payload shape; it is not a migration. This is one
of the seams that keeps tier-3 work from disturbing tier-1 work.

**`turn_id` and `request_id` are both required, and they are not the same
thing.** One agent turn produces many rows across both tables, and `turn_id`
joins them back into a single reconstructable trace — the trace *is* that join,
which is why there is no `traces` table. `request_id` is the delivery attempt: a
retry **resumes the same `turn_id` under a new `request_id`**, so without it the
trace cannot distinguish "one turn, two delivery attempts" from "one attempt".

**`llm_calls.status` exists so the row can be written *before* the network
call.** A row written only on success is missing exactly when it matters most: a
crash between "Anthropic charged us" and "row inserted" leaves no trace, and the
retry pays again. That is a money bug, not a tidiness one — and `latency_ms`
alone cannot be written before the call returns, which is why it is replaced by
`started_at` / `finished_at`.

**`messages.turn_id` closes a hole in the pipeline as originally drawn.** The
idempotency step says "duplicate? return existing turn" — but nothing mapped
`client_message_id` back to a `turn_id`. Without this column that step has
nothing to return.

### Indexes on the hot paths

```sql
messages       (chat_id, created_at desc)
chat_members   (user_id, status)
chat_members   (chat_id, status)
agent_events   (chat_id, created_at desc)
agent_events   (turn_id, created_at)                          -- the trace join, in order
llm_calls      (turn_id)                                      -- checked before every call
memory_items   (subject_user_id, status)
memory_items   USING gin (search_vector)                      -- lexical rank, D-004
memory_audience(memory_item_id)
messages       (chat_id, client_message_id) UNIQUE            -- idempotency, D-011
```

**No `embedding` column and no ANN index in v1.** D-004 closed against wiring an
embedding provider — Anthropic ships none, and a second vendor was not worth the
cost for a candidate set the authorisation filter has already cut to tens of
items. `lib/memory/embed.ts` is an unimplemented interface so the upgrade stays a
one-file change. If vectors are ever adopted: HNSW, never ivfflat (`lists =
rows/1000` degenerates to 1 at this scale), and carry an `embedding_model` column
alongside so a provider swap is detectable rather than silently wrong.

**Episodic and semantic.** `messages` and `agent_events` are the episodic
layer — what happened, in order. `memory_items` is the semantic layer distilled
from it. The distinction is worth naming because it explains why memory is
extracted rather than simply retrieved: the episodic record is already complete
and already authorised, and the semantic layer exists to make it *usable* across
conversations, which is precisely what creates the authorisation problem.

### Chat types

| Type | Humans | Admin model | Gate default |
|---|---|---|---|
| `dm` | exactly 2 | none | silent unless addressed |
| `group` | 2+ | admins, invites, join requests, removal | judge decides |
| `agent` | 1 | none | always respond |

`agent` extends the brief's stated minimum of two users. Documented as
assumption 1 in the README.

---

## 3. The agent turn

```
message received (route handler)
  ├─ idempotency check on client_message_id            → duplicate message? return existing turn
  ├─ persist message
  ├─ build ScopedAgentContext(chat_id)                 → fixes identity: chat, actor, turn_id
  ├─ rate limit check
  ├─ gate evaluation                    event: gate_evaluated
  │    └─ silent? stop here. The event is still written.
  ├─ retrieve memory (filter → rank → cap)   event: memory_retrieved {kept, filtered_out}
  │    └─ membership + clearance re-read HERE, in SQL. Not cached from construction.
  ├─ assemble context within token budget    event: context_dropped (if trimmed)
  ├─ write llm_calls row  ─────────────────  BEFORE the call, not after
  ├─ model call, streamed                    row:   llm_calls (updated with usage)
  ├─ tool loop, bounded                      events: tool_invoked, tool_result
  │    └─ after untrusted content: tools restricted to postUntrustedAllowlist
  ├─ persist agent message
  └─ deferred: extract memory                events: memory_written, memory_conflict
```

Two things this diagram is deliberately explicit about.

**`llm_calls` is written before the model call, not after.** A row written after
the fact is lost precisely when it matters most — a crash or timeout mid-call
still spent money, and an accounting system that only records successes
understates the bill in exactly the failure cases you most want to see.

**Idempotency here covers a duplicate *message*, not a duplicate *turn*.** A
retry arriving after the message was persisted but before the reply was — where
the model call already succeeded and was already billed — is **out of scope for
v1**, and is stated as a limitation rather than left looking like an oversight.
See D-011, whose resume semantics remain open.

### The diagram is not atomic, and cannot be drawn as if it were

`supabase-js` has **no multi-statement transaction**. Every `.from()` call is its
own implicit transaction, and Supavisor's transaction-mode pooling means session
state does not survive between two of them. Read literally, the first three steps
above are three separate transactions — which gives a check-then-insert race on
`client_message_id`.

The fix is one `SECURITY DEFINER` Postgres function, created in migration `0004`
and called once via `.rpc()` from `lib/db/scoped-agent.ts`:

```
send_message_and_start_turn(chat_id, content, client_message_id)
  → SECURITY DEFINER, authorises BOTH axes itself, fails closed
  → INSERT ... ON CONFLICT (chat_id, client_message_id) DO NOTHING
  → returns the resolved turn_id, new or existing, plus is_duplicate
```

This is the *only* place a transaction spans more than one statement, and it is
deliberately short and database-only. It does **not** contradict D-009: the whole
turn is not wrapped, because that would hold a connection open across the model
call.

**It runs at READ COMMITTED, not REPEATABLE READ (D-026).** The research
recommended raising the isolation level, but that recommendation was about a
general multi-table write path. This function does one idempotent insert;
`ON CONFLICT` resolves its only race at the default level, and raising it would
add `40001` serialization failures and a retry loop to every send to buy
nothing. Isolation earns its cost where a function reads several tables and
needs one consistent snapshot across them — this one does not.

### What is deliberately not in the schema

- **No `tool_calls` table.** A tool span is a `tool_invoked` / `tool_result` pair
  of `agent_events` rows sharing a `tool_call_id` inside `payload`. A new event
  type costs no migration; a new table does — the extensibility charter decides
  this on its own terms.
- **No `traces` table.** The trace is the join on `turn_id`.
- **No queue table.** Deferred extraction is `after()` from `next/server` inside
  the same invocation. It shares the invocation's timeout and is cancelled if the
  function times out; Vercel documents no durability guarantee across instance
  recycling. The entire durability story is one `memory_extraction_failed` event,
  and that is said out loud rather than implied away.

Every step writes to `agent_events`. Extraction runs *after* the response is
delivered — it keeps the user-visible turn fast and off the serverless timeout
cliff. R9 closed the "how": `after()` from `next/server`, no queue.

**Where the implementation diverges from this diagram.** There is no
`api/agent/turn/route.ts`. The turn runs inside `after()` from the message route
instead, so a send is acknowledged the moment it is persisted and the reply
arrives over Realtime. A separate turn endpoint would add a second HTTP
round-trip and a second authorisation check for no gain — the caller is our own
server, already holding a verified actor. Recorded as D-028.

**Failure is visible, not swallowed.** A model error or tool timeout writes an
event and the chat stays usable. A broken agent must never take the chat down.

---

## 4. File fan-out

### `config/` — done

| File | Responsibility |
|---|---|
| `models.ts` | Model tier registry (`reflex`/`judge`/`converse`/`reason`), pricing, effort levels, purpose→tier map, cost estimator |
| `agent.ts` | Gate thresholds and cooldown, rate limits, memory caps and weights, context budget, tool bounds, clearance ladder, kill switches |
| `env.ts` | Zod-validated env, split client/server — the split is a security boundary |
| `index.ts` | Single import surface: `@/config` |

### `lib/db/`

| File | Tier | Responsibility | Contract |
|---|---|---|---|
| `browser.ts` | t1 | Publishable-key client for client components | Never sees a secret. RLS is the guard. |
| `server.ts` | t1 | Session-bound client for route handlers and RSC | Acts *as the user*. RLS applies. |
| `scoped-agent.ts` | t2 | `ScopedAgentContext` — the agent's entire world | The only file permitted to read `SUPABASE_SECRET_KEY`. Fixes turn identity (chat, actor, `turn_id`) at construction. **Does not cache membership or clearance** — those are re-read in SQL on every privileged call, because holding them across the model call is the TOCTOU gap (D-009). |
| `types.ts` | t1 | Row types | **Currently hand-authored** from the migrations, because generation needs a provisioned project. Replaced by `pnpm supabase gen types` output at that point, after which it is generated and never hand-edited. |

### `lib/memory/`

| File | Tier | Responsibility |
|---|---|---|
| `retrieve.ts` | t2 | **The only place memory is queried.** filter → rank → cap → log. Filter is SQL; rank is TypeScript over the already-authorised set. |
| `extract.ts` | t2 | Deferred extraction from a delivered turn. Structured output, confidence-scored, capped per turn. Sub-threshold items land as `candidate`. |
| `conflict.ts` | t2 | Deterministic, ordered resolution: stated > inferred; newer > older; genuine tie writes a `memory_conflict` event. **The model is never asked which fact it prefers** — that is not reproducible. |
| `audience.ts` | t2 | Snapshot writer and containment predicate. Small, and heavily tested. |
| `embed.ts` | t2 | Embedding provider behind an interface. Blocked on D-004 / R3. |

### `lib/agent/`

| File | Tier | Responsibility |
|---|---|---|
| `gate.ts` | t1 | Deterministic chain (rules 1–6), then the judge. Returns `{verdict, rule, reason}`. Pure and trivially unit-testable — the chain takes a message plus chat state, not a database. |
| `orchestrator.ts` | t2 | The turn pipeline above. Owns `turn_id`. Owns ordering; owns nothing else. |
| `context.ts` | t2 | Prompt assembly within the token budget; emits `context_dropped`. |
| `prompts/` | t2 | System prompts as files, not string literals in logic. |
| `tools/index.ts` | t3 | Tool registry + the shared `Tool` interface |
| `tools/web-search.ts` | t3 | Bounded search; results summarised into context, never dumped raw |
| `tools/file-read.ts` | t3 | Storage read *through the scoped context* |
| `tools/research.ts` | t3 | Bounded multi-step loop with a hard step cap |

**Tool interface, so a new tool is one file:**

```ts
interface Tool<I, O> {
  name: string;
  description: string;
  inputSchema: ZodSchema<I>;               // validated before execution
  execute(input: I, ctx: ScopedAgentContext): Promise<O>;
}
```

A signature expresses intent; it does not enforce it. Nothing here stops a tool
module importing `lib/db/server.ts` and constructing its own client — that is
what `scripts/check-boundaries.mjs` is for, and even that is a build failure
rather than a security control.

What makes this capability-style rather than ambient authority is a **stated,
tested invariant**, not the type:

> **No `ScopedAgentContext` method accepts a scope-defining id as a parameter.**
> No `chat_id`, no other user's id. Scope comes from the context's construction
> and nowhere else.

The invariant is what carries the weight. Tool input is transitively
model-controlled, so it is injection-influenceable; a method taking a `chat_id`
from tool input would let a crafted document redirect the agent's reads, and the
context would have degraded into ambient authority with extra steps. The
distinction — permission to *invoke* a tool is not permission to reach every
resource that tool could touch — is research track R6, and the seam table in §5
inherits authorisation from `ctx` **only under this invariant**.

### `lib/llm/`

| File | Tier | Responsibility |
|---|---|---|
| `provider.ts` | t1 | Interface: `complete()` and `structured()` today; `stream()` is Phase 2. Purpose-addressed, not model-addressed — callers pass a `CallPurpose`, never a model id. |
| `anthropic.ts` | t1 | The implementation. Maps tier config → request shape (effort, thinking) and normalises errors. It does **not** record `llm_calls` — that is `instrumented.ts`, a wrapper, so swapping providers does not disturb accounting and vice versa. |
| `errors.ts` | t1 | Typed failures, each carrying `retryable`. Callers branch on `kind`, never on message strings. |
| `instrumented.ts` | t1 | Wraps a provider to write the `llm_calls` row **before** the network call, then update it. |

### `lib/events/`

| File | Tier | Responsibility |
|---|---|---|
| `log.ts` | t1 | Append-only `agent_events` writer. Insert only — no update, no delete. |
| `types.ts` | t1 | Discriminated union of event payloads. Adding a variant is a type change, not a migration. |

### `app/`

| Path | Tier | Responsibility |
|---|---|---|
| `proxy.ts` | t1 | Session refresh + redirect. **Next 16 renamed `middleware.ts`, and the name change is useful here:** this is UX, not a guard. CVE-2025-29927 let a spoofed header skip every middleware check — the lesson is thesis #2. RLS is the boundary. |
| `app/auth/callback/route.ts` | t1 | PKCE `exchangeCodeForSession`. Must return `Cache-Control: private, no-store`, or a CDN can serve one user's session response to another. |
| `(marketing)/page.tsx` | t1 | Landing + sign in with Google |
| `(app)/layout.tsx` | t1 | Auth guard, profile bootstrap. Resolves the actor with **`getClaims()`, never `getSession()`** — Supabase says not to trust the latter server-side because it does not revalidate, and an authorisation decision made on it runs on a claim Supabase itself would reject. |
| `(app)/chats/page.tsx` | t1 | **List view — ships first, remains the fallback** |
| `(app)/chat/[chatId]/page.tsx` | t1 | Full-screen chat |
| `(app)/space/page.tsx` | t3 | Force-directed space view — **`d3-force` with SVG, not canvas.** Canvas costs hand-rolled hit-testing and accessibility work in the feature most likely to be cut; at a few hundred nodes SVG is fine. |
| `api/chats/route.ts` | t1 | Create / list |
| `api/chats/[chatId]/messages/route.ts` | t1 | Send message; idempotent on `client_message_id` |
| `api/chats/[chatId]/members/route.ts` | t2 | Invite, request, approve, remove, promote |
| `api/agent/turn/route.ts` | t2 | Agent pipeline entry, streaming |
| `api/chats/[chatId]/events/route.ts` | t2 | Internal-view feed |

### `supabase/migrations/`

Numbered, additive, never edited once applied. **Every table gets its RLS policy
in the migration that creates it.**

```
0001_extensions.sql          pgcrypto
0002_profiles_clearances.sql profiles, clearances, user_clearances + RLS
0003_chats_members.sql       chats, chat_members + RLS + the membership predicate fn
0004_messages.sql            messages + RLS + idempotency constraint
                             + send_message_and_start_turn() RPC
0005_agent_events.sql        agent_events, llm_calls + RLS
0006_memory.sql              memory_items, memory_audience
                             RLS ON, NO permissive policy, grants revoked
0007_files.sql               files + storage bucket policies
0008_seed_clearances.sql     the clearance ladder from config/agent.ts
```

No `vector` extension in `0001` — D-004 closed against embeddings in v1.

The membership/clearance predicate is a `security definer` function so the
policies stay readable and do not recurse through `chat_members` — a known RLS
footgun, and part of research track R1.

### `tests/`

Organised by the claim under test, not by source file.

```
config.test.ts                      tier/model invariants, no DB or key needed
authorization/  rls-foundation.test.ts  membership.test.ts  clearance.test.ts
                messages.test.ts
memory/         isolation.test.ts       lifecycle.test.ts
agent/          gate.test.ts            judge.test.ts       llm-errors.test.ts
                scoped-context-invariant.test.ts  output-sanitisation.test.ts
auth/           dev-login-gate.test.ts
tools/          scoping.test.ts
```

Everything under `authorization/`, `memory/` and `tools/` runs against a real
Postgres 18.4 as an **unprivileged role** — testing RLS through a service-role
client tests nothing. Docker is not available on the development machine, so the
harness runs genuine Postgres binaries via `embedded-postgres` rather than a
container; an in-JS emulator was rejected because it does not implement RLS.
Details in [`tests/README.md`](../tests/README.md).

---

## 5. What makes this extensible

The tiering only works if tier-3 work does not force tier-1 rewrites. The seams
that guarantee that:

| Seam | Adding a... | Cost |
|---|---|---|
| `llm/provider.ts` | model, provider, fallback chain | one file |
| `agent/tools/*` | tool | one file, authz inherited from `ctx` |
| `db/scoped-agent.ts` | agent-readable data source | one method, authz inherited |
| `agent_events.payload` | event type | no migration |
| `config/*` | threshold, tier, clearance | no code change |
| `memory/retrieve.ts` | ranking signal | rank step only; filter untouched |
| `migrations/` | schema change | new file, never an edit |

The load-bearing one is `ScopedAgentContext`. Because every agent read goes
through it, a new capability inherits the authorisation boundary rather than
re-implementing it — which is the difference between adding a tool and adding a
vulnerability.
