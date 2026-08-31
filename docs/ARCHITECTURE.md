# Architecture

High-level design and the file-by-file fan-out. Written before implementation so
that the shape is argued about once, in one place, rather than emerging by
accident.

Status: **Tier 1 complete; most of Tier 2 shipped** — memory retrieval and
extraction, connectors (Gmail/Calendar), admin mode, and a demo world are all
built alongside the base chat/authorisation surface. Live progress per item is
in [PLAN.md](../PLAN.md); this document describes the shape, not the state.
Where implementation diverged from what was designed here, the divergence is
recorded inline rather than quietly conformed to. §6 lists what shipped beyond
this diagram's original scope.

---

## 1. Shape of the system

```
Browser
  │  Supabase JS (publishable key) — reads go direct, RLS is the guard
  │  fetch() — writes and all agent work go through route handlers
  ▼
Next.js App Router  (Vercel)
  ├── page.tsx             public landing + sign in
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
| `types.ts` | t1 | Row types | Generated via `supabase gen types typescript --linked`, regenerated after every migration. Never hand-edited. |
| `rows.ts` | t1 | Narrow, hand-named row shapes for common joins (the generated types embed relations as arrays regardless of cardinality) | — |
| `profiles.ts` | t1 | `namesFor()` — the one helper that turns a set of user ids into `{name, color}`, because a `profiles` embed cannot express "only if still a member" | — |

### `lib/memory/`

| File | Tier | Responsibility |
|---|---|---|
| `retrieve.ts` | t2 | **The only place memory is queried.** filter → rank → cap → log. Filter is SQL; rank is TypeScript over the already-authorised set. |
| `extract.ts` | t2 | Deferred extraction from a delivered turn. Structured output, confidence-scored, capped per turn. Sub-threshold items land as `candidate`. |
| `conflict.ts` | t2 | Deterministic, ordered resolution: stated > inferred; newer > older; genuine tie writes a `memory_conflict` event. **The model is never asked which fact it prefers** — that is not reproducible. |
| `audience.ts` | t2 | Snapshot writer and containment predicate. Small, and heavily tested. |
| `embed.ts` | t2 | Embedding provider behind an interface. Blocked on D-004 / R3. |
| `mine.ts` | t2 | `myMemory()` — the subject-access read. Deliberately **not** filtered by the surfacing rule: what the agent knows about you and what it may repeat in a given room are different questions, and this answers the first. Backed by `public.my_memory()` (migration 0019), which returns only rows where `subject_user_id = auth.uid()`. |

### `lib/agent/`

| File | Tier | Responsibility |
|---|---|---|
| `gate.ts` | t1 | Deterministic chain (rules 1–6, including name/prefix addressing — `@q`, `@quorum`, or "Q"/"Quorum" at message start), then the judge. Returns `{verdict, rule, reason}`. Pure and trivially unit-testable — the chain takes a message plus chat state, not a database. |
| `judge.ts` | t1 | The LLM step of the gate: a discrete verdict (D-020), never a thresholded float, biased to silence (D-008). |
| `orchestrator.ts` | t2 | The turn pipeline above. Owns `turn_id`. Owns ordering; owns nothing else. |
| `context.ts` | t2 | Prompt assembly within the token budget; emits `context_dropped`. |
| `research.ts` | t2 | The bounded multi-step research loop (D-022 least-privilege applies once it touches untrusted content) |
| `catalogue.ts` | t2 | Hand-written description of every capability, for the Capabilities page — kept in sync with the tool registry by `tests/ui/catalogue.test.ts`, not generated from it |
| `prompts/` | t2 | System prompts as files, not string literals in logic. |
| `tools/index.ts` | t3 | Tool registry + the shared `Tool` interface |
| `tools/web.ts` | t3 | Bounded web search/fetch; `url-safety.ts` blocks private/link-local targets (SSRF) before a fetch is attempted |
| `tools/file.ts` | t3 | Storage read *through the scoped context* |
| `tools/document.ts` | t3 | PDF (`unpdf`) and DOCX (`mammoth`) text extraction, plus extract-to-schema with quotes checked against the source text |
| `tools/connectors.ts` | t3 | Gmail/Calendar reads via the user's own OAuth grant (`lib/connectors/`), scoped read-only |
| `tools/session.ts` | t3 | Per-turn tool session bookkeeping (the post-untrusted-content allowlist switch, D-022) |
| `tools/fence.ts` | t3 | Delimits untrusted tool output before it re-enters the model's context. Documented as **defence in depth, not a security control** — the actual guarantee against injection is D-022's post-untrusted tool cutoff, enforced in code outside the model's reach. |

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

### `lib/connectors/` — read-only Gmail and Calendar (t3)

| File | Responsibility |
|---|---|
| `google.ts` | Four hand-written `fetch` calls, not the generated `googleapis` client — a stray call the client permits but the granted scopes don't is a call nobody reviewed; four endpoints are auditable in one screen. |
| `crypto.ts` | AES-256-GCM envelope encryption for refresh tokens at rest. RLS defends against a query; a backup or a support tool reading the table directly is a different failure mode, so the token is unreadable even then. |

`connector_tokens` (migration `0014`) has RLS **on with zero policies** — the
table is reachable only through `SECURITY DEFINER` functions, never a direct
`select`.

### `lib/auth/` — session and demo-mode gates (t1)

| File | Responsibility |
|---|---|
| `admin-mode.ts` | Gates the self-service clearance/membership grant used to demonstrate both authorisation axes from one browser. Three independent switches (env flag, server-only secret, an empty-by-default DB row) so a production deploy with none of them set leaves the feature dead regardless of the others. Named plainly as a self-service privilege escalation — see the file's own header — never described as safe in general. |
| `dev-users.ts` | The seeded cast (`alice`…`erin`) and `devLoginEnabled()`, chosen so a single glance at the chat list demonstrates axis-independence (a member with no clearance) and the clearance floor (identical membership, different clearance). |
| `profile.ts` | `ensureProfile()` and the deterministic per-user colour, so a person is the same colour everywhere without storing a choice. |

### `lib/demo/` — the guided first-run world (t1)

| File | Responsibility |
|---|---|
| `seed.ts` | `ensureDemoWorld()` / `resetDemoWorld()`, thin wrappers around the `SECURITY DEFINER` RPCs in migration `0020`. Called through the session-bound client, never the service role — a demo room is built with the same authority the user already has, not manufactured by an agent that bypasses it. |
| `suggestions.ts` | Composer suggestion chips for the two demo rooms. Sent through the ordinary message path when tapped — same idempotency RPC, same gate — deliberately not a second send path. |
| `sample-pdf.ts` | A hand-written, genuinely-parseable one-page PDF for the contract-review room, so the demo exercises the real `document_extract` path rather than a renamed `.txt`. |

Exactly two rooms per new signup, one seed message total: a DM with "Priya"
(one backdated message plus the sample PDF) and a group with Priya **and**
Sam that deliberately carries no seed message — its only job is being a room
Priya was in that Sam wasn't, so memory withholding has something real to
withhold. A broader "scripted reply mid-conversation on behalf of another
user" design was considered and rejected as a message-forgery primitive; see
the header of migration `0020`.

### `lib/ui/` — rendering attacker-controlled content (t1)

| File | Responsibility |
|---|---|
| `markdown.ts` | Parses message content to a typed tree, not an HTML string — there is no `dangerouslySetInnerHTML` for an injected `<script>` to reach, because no HTML string is ever produced. `![x](y)` deliberately downgrades to a link node, never an `<img>` (which would fetch on the reader's behalf with no click). |
| `safe-url.ts` | Only `http:`/`https:` become clickable links; `javascript:`, `data:`, `vbscript:`, `file:` render as inert text. |

### `app/`

| Path | Tier | Responsibility |
|---|---|---|
| `proxy.ts` | t1 | Session refresh + redirect. **Next 16 renamed `middleware.ts`, and the name change is useful here:** this is UX, not a guard. CVE-2025-29927 let a spoofed header skip every middleware check — the lesson is thesis #2. RLS is the boundary. |
| `app/auth/callback/route.ts` | t1 | PKCE `exchangeCodeForSession`. Must return `Cache-Control: private, no-store`, or a CDN can serve one user's session response to another. |
| `page.tsx` | t1 | Landing + sign in (Google, plus seeded dev accounts when `ALLOW_DEV_LOGIN=true`) |
| `auth/dev/route.ts` | t1 | Dev-only sign-in bypass — 404s rather than 403s when disabled, so a probe cannot confirm it exists. Three independent gates; see the file's own header. |
| `(app)/layout.tsx` | t1 | Auth guard, profile bootstrap, demo-world bootstrap. Resolves the actor with **`getClaims()`, never `getSession()`**. |
| `(app)/chats/page.tsx` | t1 | Workspace — People/Groups directory, the "who and what exists here" view |
| `(app)/people/page.tsx` | t1 | **Rooms** — every conversation you're in, Slack-shaped: a list on the left, the open one (chat + roster + internal view) on the right. Accepts `?open=<chatId>` to pre-select a room. |
| `(app)/chat/[chatId]/page.tsx` | t1 | **A redirect, not a page** — `redirect('/people?open=' + chatId)`. Superseded by Rooms once Rooms could show a chat, roster and internal view together; kept only so old links (pop-outs, the account page's group list) still resolve. |
| `(app)/account/page.tsx` | t1 | Your own clearance ladder, your rooms, and clearance-granting (`grant_clearance()`, D-003's write path) |
| `(app)/memory/page.tsx` | t2 | Subject-access view — what the agent has learned about *you*, via `my_memory()`, independent of the surfacing rule |
| `(app)/connectors/page.tsx` | t3 | "Capabilities" — every tool the agent can call, from `lib/agent/catalogue.ts`; Google OAuth connect/disconnect |
| `(app)/admin/page.tsx` | t1 | Admin mode UI — `notFound()`, never `403`, when the feature is disabled |
| `(app)/usage/page.tsx` | t2 | `llm_calls` cost/usage rollup |
| `api/chats/route.ts` | t1 | Create / list groups |
| `api/dm/route.ts` | t1 | Find-or-create a DM for a pair, so the same two people never end up with two DMs splitting one memory audience across rooms |
| `api/chats/[chatId]/messages/route.ts` | t1 | Send message; idempotent on `client_message_id`; kicks off the agent turn in `after()` |
| `api/chats/[chatId]/members/route.ts` | t2 | Invite, request, approve, remove, promote |
| `api/chats/[chatId]/files/route.ts` | t2 | Upload, scoped to the chat |
| `api/clearances/route.ts` | t1 | Grant a clearance rung (never above the granter's own) |
| `api/connectors/google/{start,callback}/route.ts` | t3 | OAuth authorize/exchange; CSRF `state` compared with `timingSafeEqual` |
| `api/demo/reset/route.ts` | t1 | Rebuilds the caller's own demo world only |
| `api/admin/route.ts` | t1 | Dispatches to the `dev_self_*` admin-mode RPCs |

**No `api/agent/turn/route.ts` and no `api/chats/[chatId]/events/route.ts`.**
The turn runs inside the message route's `after()` rather than a second
endpoint (D-028, below), and the internal view reads `agent_events`/`llm_calls`
directly through the browser client — RLS is the same guard either way, so a
proxy endpoint would add a round-trip for no additional authorisation.

**No `(app)/space/page.tsx`.** The force-directed space view (D-025) was
Tier-3, list-view-first work, and the 12-hour budget did not reach it.

### `supabase/migrations/`

Numbered, additive, never edited once applied. **Every table gets its RLS policy
in the migration that creates it.**

```
0001_extensions.sql              pgcrypto
0002_profiles_clearances.sql     profiles, clearances, user_clearances + RLS
0003_chats_members.sql           chats, chat_members + RLS + the membership predicate fn
0004_messages.sql                messages + RLS + idempotency constraint
                                 + send_message_and_start_turn() RPC
0005_agent_events.sql            agent_events, llm_calls + RLS
0006_memory.sql                  memory_items, memory_audience
                                 RLS ON, NO permissive policy, grants revoked
0007_files.sql                   files + storage bucket policies
0008_seed_clearances.sql         the clearance ladder from config/agent.ts
0009_rpc_surface.sql             public RPC wrappers over the `private` predicates, service_role only — what scoped-agent.ts calls to re-check per D-009
0010_memory_rpc.sql              memory_for_chat(), write_memory_item() — the only entry points into memory_items
0011_create_chat.sql             create_chat() RPC — atomic chat + first-member insert, closing the same orphaned-chat/zero-member gap T1 warns about
0012_grant_clearance.sql         grant_clearance() — never above the granter's own level
0013_storage_policies.sql        Storage bucket policies for file attachments
0014_connector_tokens.sql        connector_tokens — RLS on, ZERO policies; AES-256-GCM at rest
0015_realtime_publication.sql    adds messages + agent_events to supabase_realtime
0016_admin_mode.sql              private.admin_mode_secret (empty by design), admin_mode_log, dev_self_* RPCs
0017_default_groups.sql          auto-join new signups to ungated groups
0018_backfill_default_groups.sql one-time backfill for pre-existing accounts
0019_my_memory.sql               my_memory() — the subject-access read, ignores the surfacing rule on purpose
0020_demo_world.sql              ensure_demo_world() / reset_demo_world(); excludes demo chats from 0017's auto-join
```

No `vector` extension in `0001` — D-004 closed against embeddings in v1.

The membership/clearance predicate is a `security definer` function so the
policies stay readable and do not recurse through `chat_members` — a known RLS
footgun, and part of research track R1.

### `tests/`

Organised by the claim under test, not by source file.

```
config.test.ts, config-env.test.ts        tier/model invariants, no DB or key needed
authorization/  rls-foundation  membership  clearance  clearance-grants
                messages  create-chat  connector-tokens  demo-world
memory/         isolation  lifecycle  conflict  ranking  mine  my-memory  rpc
agent/          gate  judge  research  llm-errors
                scoped-context-invariant  output-sanitisation
auth/           dev-login-gate
tools/          scoping  document  session  url-safety  safe-name
connectors/     crypto  registration
files/          extract-text
ui/             catalogue  event-trace  markdown
```

(each entry above is `<name>.test.ts` under its directory)

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

---

## 6. What shipped beyond this diagram

This document was written before implementation and describes the shape
argued about at the start. Several things were built during Tier 2 that this
diagram never anticipated, listed here rather than woven back into §1–5 as if
they had always been planned:

- **Memory subject access** (`lib/memory/mine.ts`, `my_memory()`, the
  `/memory` page) — a second, deliberately *un*-filtered read path into
  `memory_items`, answering "what does the agent know about me" rather than
  "what may it repeat in this room."
- **Connectors** (`lib/connectors/`, `/connectors`) — read-only Gmail and
  Calendar, gated per-user (their own OAuth grant, not a shared credential)
  and gated twice (connector present *and* the tool call scoped to it).
- **Admin mode** (`lib/auth/admin-mode.ts`, migration `0016`, `/admin`) — a
  named, three-gated, self-service privilege escalation that exists solely so
  the two-axis authorisation model is demonstrable from one browser.
- **A demo world** (`lib/demo/`, migration `0020`) — two seeded rooms per new
  signup, built to make audience isolation something a reviewer can *see*
  happen rather than take on faith.
- **Rooms** (`app/(app)/people/page.tsx`, `app/_components/rooms/`) — the
  Slack-shaped list-plus-open-conversation view that `/chat/[chatId]`
  redirects into; it renders the same `ChatSurface`, `Roster` and
  `InternalView` the old full-page route did, loaded client-side per
  selection instead of per navigation.
- **Floating panels** (`app/_components/floating-panels/`) — pop-out chat
  windows over the Workspace view, so opening someone's DM does not require
  leaving whatever else is on screen.
- **The redaction visual system** (`app/_components/clearance.tsx`) — colour
  encodes clearance and nothing else; `<Redacted>` takes a width, never
  content, because CSS-hidden text still reaches view-source and the
  clipboard.
