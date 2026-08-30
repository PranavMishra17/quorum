# Architecture

High-level design and the file-by-file fan-out. Written before implementation so
that the shape is argued about once, in one place, rather than emerging by
accident.

Status: **design**. Nothing below is implemented yet. Paths marked `(t1)`,
`(t2)`, `(t3)` map to the build tiers in [BUILD-PLAN.md](BUILD-PLAN.md).

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
                      content, client_message_id (idempotency), created_at
memory_items          id, subject_user_id, origin_chat_id, origin_message_id,
                      content, embedding vector, clearance_level int,
                      source_type ('stated'|'inferred'), confidence,
                      status ('candidate'|'active'|'superseded'|'stale'),
                      superseded_by, created_at, expires_at
memory_audience       memory_item_id, user_id          ← the critical table
agent_events          id, chat_id, turn_id, message_id nullable,
                      event_type, payload jsonb, created_at
llm_calls             id, chat_id, turn_id, message_id, model, tier, purpose,
                      input_tokens, output_tokens, cost_estimate,
                      latency_ms, created_at
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

**`turn_id` threads through `agent_events` and `llm_calls`.** One agent turn
produces many rows across both tables; a correlation id is what turns them back
into a single reconstructable trace. See research track R10.

### Indexes on the hot paths

```sql
messages       (chat_id, created_at desc)
chat_members   (user_id, status)
chat_members   (chat_id, status)
agent_events   (chat_id, created_at desc)
memory_items   (subject_user_id, status)
memory_items   USING ivfflat (embedding vector_cosine_ops)   -- or hnsw, see R3
memory_audience(memory_item_id)
messages       (chat_id, client_message_id) UNIQUE            -- idempotency, see R8
```

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
  ├─ idempotency check on client_message_id            → duplicate? return existing turn
  ├─ persist message
  ├─ build ScopedAgentContext(chat_id)                 → member set, clearance, actor
  ├─ rate limit check
  ├─ gate evaluation                    event: gate_evaluated
  │    └─ silent? stop here. The event is still written.
  ├─ retrieve memory (filter → rank → cap)   event: memory_retrieved {kept, filtered_out}
  ├─ assemble context within token budget    event: context_dropped (if trimmed)
  ├─ model call, streamed                    row:   llm_calls
  ├─ tool loop, bounded                      events: tool_invoked, tool_result
  ├─ persist agent message
  └─ deferred: extract memory                events: memory_written, memory_conflict
```

Every step writes to `agent_events`. Extraction runs *after* the response is
delivered — it keeps the user-visible turn fast and off the serverless timeout
cliff. How "after" is implemented (Vercel `waitUntil` vs a real queue) is open;
see research track R9.

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
| `scoped-agent.ts` | t2 | `ScopedAgentContext` — the agent's entire world | The only file permitted to read `SUPABASE_SECRET_KEY`. Constructed per turn from a chat id; resolves member set + clearance + actor; every read method applies both authorisation axes in SQL. |
| `types.ts` | t1 | Generated Supabase types | `pnpm supabase gen types` output. Regenerate, never hand-edit. |

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

Note the signature: `execute` cannot reach the database except through `ctx`.
Tool authorisation is therefore resource-level by construction — permission to
*invoke* a tool is not permission to reach every resource that tool could touch.
That distinction is research track R6.

### `lib/llm/`

| File | Tier | Responsibility |
|---|---|---|
| `provider.ts` | t1 | Interface: `complete()`, `stream()`, `structured()`. Purpose-addressed, not model-addressed — callers pass a `CallPurpose`, never a model id. |
| `anthropic.ts` | t1 | The implementation. Maps tier config → request shape (effort, thinking, streaming), records `llm_calls`, normalises errors. |
| `errors.ts` | t1 | Typed failures: rate-limited, refused, timed out, malformed. Callers branch on type, never on message strings. |

### `lib/events/`

| File | Tier | Responsibility |
|---|---|---|
| `log.ts` | t1 | Append-only `agent_events` writer. Insert only — no update, no delete. |
| `types.ts` | t1 | Discriminated union of event payloads. Adding a variant is a type change, not a migration. |

### `app/`

| Path | Tier | Responsibility |
|---|---|---|
| `(marketing)/page.tsx` | t1 | Landing + sign in with Google |
| `(app)/layout.tsx` | t1 | Auth guard, profile bootstrap |
| `(app)/chats/page.tsx` | t1 | **List view — ships first, remains the fallback** |
| `(app)/chat/[chatId]/page.tsx` | t1 | Full-screen chat |
| `(app)/space/page.tsx` | t3 | Force-directed bubble canvas |
| `api/chats/route.ts` | t1 | Create / list |
| `api/chats/[chatId]/messages/route.ts` | t1 | Send message; idempotent on `client_message_id` |
| `api/chats/[chatId]/members/route.ts` | t2 | Invite, request, approve, remove, promote |
| `api/agent/turn/route.ts` | t2 | Agent pipeline entry, streaming |
| `api/chats/[chatId]/events/route.ts` | t2 | Internal-view feed |

### `supabase/migrations/`

Numbered, additive, never edited once applied. **Every table gets its RLS policy
in the migration that creates it.**

```
0001_extensions.sql          pgcrypto, vector
0002_profiles_clearances.sql profiles, clearances, user_clearances + RLS
0003_chats_members.sql       chats, chat_members + RLS + the membership predicate fn
0004_messages.sql            messages + RLS + idempotency constraint
0005_agent_events.sql        agent_events, llm_calls + RLS
0006_memory.sql              memory_items, memory_audience + DENY-ALL policies
0007_files.sql               files + storage bucket policies
0008_seed_clearances.sql     the clearance ladder from config/agent.ts
```

The membership/clearance predicate is a `security definer` function so the
policies stay readable and do not recurse through `chat_members` — a known RLS
footgun, and part of research track R1.

### `tests/`

Organised by the claim under test, not by source file.

```
authorization/  membership.test.ts  clearance.test.ts  admin.test.ts  rls.test.ts
memory/         isolation.test.ts   lifecycle.test.ts  conflict.test.ts  retrieval.test.ts
agent/          gate.test.ts        orchestrator.test.ts
tools/          scoping.test.ts
```

`rls.test.ts` runs against a real Postgres as an *unprivileged* role. Testing RLS
through a service-role client tests nothing.

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
