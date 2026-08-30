# Quorum — build plan and live status

**This file is the answer to "where are we?"** It is updated as part of the same
commit as the work it describes, so it is never stale. Detail lives in
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md); this is the map.

---

## At a glance

```
PHASE 1  MVP · submittable                    ███████████████░  ~90%
PHASE 2  Memory + agent depth + polish        ████████████████  100%
PHASE 3  Tools, capability, polish, submit    ███████░░░░░░░░░  ~45%   ← WE ARE HERE
```

**Right now:** Phase 2. A sanity check against `docs/ARCHITECTURE.md` found one
genuine Phase 1 miss — chat creation — plus four items that were in the fan-out
but never in this plan. All are listed below rather than quietly absorbed.

**Phase 2 sanity check** found one real gap and two usability blockers, all now
closed:

| Found | Status |
|---|---|
| `user_clearances` had **no write path at all** — a fresh user held nothing, could not see or create a gated chat, and axis two was unreachable outside the seed script | ✅ `grant_clearance` / `revoke_clearance` (0012) + a People page. 16 assertions. |
| The first user in an empty workspace could never be granted anything — nobody held a clearance to grant from | ✅ `claim_base_clearance()` hands out the level-0 rung only, which gates nothing |
| `pnpm dev` on a fresh clone threw out of the env schema | ✅ renders a setup page instead |

**Immediately next:** Phase 3 — the file tool first, since it is the cheapest and
it proves resource-level authorisation.

> Phase 2 shows progress already because the memory *schema* and its isolation
> tests landed with the migrations. That was deliberate: the schema is one
> coherent unit, and splitting it would have meant editing applied migrations
> later. The memory *logic* (`lib/memory/`) is still entirely Phase 2.

---

## The rule that orders everything

Running out of time must degrade **the demo**, not **the substance**. So each
phase ends at a state that could be submitted as-is, and everything graded sits
ahead of everything decorative.

Each row's **Proof** column names what makes it done. "It compiles" is not proof.

---

## Phase 1 — Minimal viable product

*Every literal requirement of the brief, working and deployed.*

### 1.1 Data layer — **COMPLETE**

| ✔ | Item | Proof |
|---|---|---|
| ✅ | Migration `0001` extensions, `private` schema | applies clean |
| ✅ | `0002` profiles, clearances, user_clearances + RLS | 13 assertions |
| ✅ | `0003` chats, chat_members, **both authorisation axes** | 28 assertions |
| ✅ | `0004` messages + idempotency RPC | 22 assertions |
| ✅ | `0005` agent_events, llm_calls | covered above |
| ✅ | `0006` memory + the surfacing rule in SQL | 23 assertions |
| ✅ | `0007` files | 12 assertions |
| ✅ | `0008` clearance seed | drift-guard test |
| ✅ | `0009` public RPC surface, `service_role` only | grant asserted |
| ✅ | Real-Postgres test harness, no Docker | 138 passing |
| ✅ | `auth.uid()` inside `SECURITY DEFINER` (**T5**) | proven, first assertion |
| ✅ | Vacuous-truth fail-open guard (**T1**) | proven by negative control |
| ✅ | CI: boundaries · lint · test · build, + a real-Postgres job | both green |

### 1.2 Application plumbing — **COMPLETE**

| ✔ | Item | Proof |
|---|---|---|
| ✅ | `lib/db/browser.ts` — publishable key, RLS enforced | builds; RLS proven at the data layer |
| ✅ | `lib/db/server.ts` — session-bound, `getClaims()` not `getSession()` (**T6**) | uses getClaims; acts as the user |
| ✅ | `lib/db/scoped-agent.ts` — the **only** service-role site | 18 assertions; **negative control passed** |
| 🟡 | `lib/db/types.ts` — hand-authored placeholder | replaced by `supabase gen types` once provisioned |
| ✅ | `proxy.ts` — UX redirect only, **not** a guard (**T7**) | Next recognises it; no authz decision in it |
| ✅ | `app/auth/callback/route.ts` — PKCE, `no-store` on every path (**T8**) | open-redirect guarded |

### 1.3 Auth and identity — **COMPLETE**

| ✔ | Item | Proof |
|---|---|---|
| 🟡 | Google OAuth end to end | code done; needs a provisioned project to verify |
| ✅ | Seeded dev login, hard-gated to non-production | 10 assertions + a boundary rule, both negative-controlled |
| ✅ | Profile bootstrap on first sign-in | inserts via the session client, so RLS still enforces self-only |

### 1.4 Chat surface — **COMPLETE**

| ✔ | Item | Proof |
|---|---|---|
| ✅ | Chat list (the permanent fallback UI — D-017) | no membership clause in the query; RLS filters |
| ✅ | Message list + composer, optimistic send | reconciles via Realtime, not by appending |
| ✅ | Realtime subscription | limitation T11 stated in code, not hidden |
| ✅ | Message rendering: human left, agent right, per-user colour | agent is monochrome + monospace label |
| ✅ | Output sanitisation at render (**R7 — Phase 1, not 3**) | 14 assertions; codebase-wide scan, negative-controlled |

### 1.5 The agent speaks — **COMPLETE**

| ✔ | Item | Proof |
|---|---|---|
| ✅ | `lib/llm/provider.ts` interface + `errors.ts` typed union | 16 assertions; spend-cap is not retryable |
| ✅ | `lib/llm/anthropic.ts`, SDK at `maxRetries: 0` (**T9**) | per-model thinking/effort read from config |
| ✅ | `llm_calls` written **before** the call | status + started_at/finished_at, not latency_ms |
| ✅ | `lib/events/log.ts` append-only writer | ids come from ctx, never from arguments |
| ✅ | `lib/agent/gate.ts` — deterministic chain, rules 1–6 | 25 assertions; pure, no DB, no clock |
| ✅ | Gate judge, discrete verdict (D-020) | 18 assertions; every failure path resolves to silence |
| ✅ | `lib/agent/orchestrator.ts` — the turn pipeline | rate limit above the gate; a turn failure never kills the chat |

### 1.6 Carried over — found by the ARCHITECTURE sanity check

Listed here rather than folded silently into Phase 2, because "Phase 1 complete"
was claimed and one of these makes that not quite true.

| ✔ | Item | Why it matters |
|---|---|---|
| ✅ | `app/api/chats/route.ts` — create | 15 assertions; atomic `create_chat()` RPC |
| ✅ | New-chat UI: DM, group, and the `agent` chat type | gate rule 2 is now reachable in the running app |
| ✅ | `lib/agent/prompts/` — prompts as files | judge, reply and extract prompts now live apart from the logic |

**Phase 1 exit gate:** deployed; two real users converse; the agent speaks
appropriately; a non-member gets nothing. Submittable.

> **Memory is deliberately absent from Phase 1 behaviour.** A half-built memory
> system with no isolation is worse than none — it demonstrates the exact leak
> the project claims to solve. The schema exists; nothing reads it yet.

---

## Phase 2 — Memory, agent architecture, polish

*The three things actually being graded, done thoroughly and **visibly**.*

| ✔ | Item | Proof |
|---|---|---|
| ✅ | Memory schema + audience snapshot | 23 isolation assertions |
| ✅ | The surfacing rule in SQL, filter-before-rank | negative control on the fail-open |
| ✅ | `lib/memory/audience.ts` — snapshot writer | atomic with the item; refuses an empty audience |
| ✅ | `lib/memory/retrieve.ts` — filter → rank → cap | 13 RPC assertions + 22 pure ranking/conflict |
| ✅ | Ranking: `ts_rank` + recency + speaker presence (D-004) | pure and unit-tested; cannot leak by construction |
| ✅ | Per-subject cap | asserted: a hogged subject cannot fill the budget |
| ✅ | `lib/memory/extract.ts`, deferred (D-013) | runs after the reply is persisted and broadcast |
| ✅ | Untrusted-turn policy → `inferred` + `candidate` (**T10**) | applied after the model speaks, so phrasing cannot evade it |
| ✅ | `lib/memory/conflict.ts` — deterministic, never the model (D-014) | 13 assertions; model detects, code decides |
| ✅ | `ScopedAgentContext` re-reads authz per call (**T2**, D-009) | 18 assertions, negative-controlled |
| ✅ | Group admin UI | roster with promote/remove/approve/leave; buttons are UX, RLS refuses |
| ✅ | Realtime revocation broadcast (**T11**) | narrows the window; documented as cooperative, not enforcement |
| ✅ | **Agent internal view** — the single best demo artifact | shows withheld counts, phrased for a reviewer |
| ✅ | Token + cost accounting per chat and globally | RLS-scoped; no cross-chat admin view by design |
| ✅ | `api/chats/[chatId]/members/route.ts` | delegates entirely to RLS; no duplicated checks |
| ✅ | ~~`api/chats/[chatId]/events/route.ts`~~ | not needed — the view reads `agent_events` directly under RLS |
| ✅ | Streaming transport for large-`max_tokens` tiers (D-029) | was a latent bug: the config flag was decorative. Client-side streaming deliberately skipped. |

**Phase 2 exit gate:** the thesis is provable **and visible on screen**. A memory
isolation rule you cannot see working is indistinguishable from one that does
not work.

---

## Phase 3 — Tools, capability, polish, submission

*Everything here is cuttable, in this order, without touching anything above.*

| ✔ | Priority | Item | Cut if |
|---|---|---|---|
| ✅ | 1 | File upload + read tool | ctx.readFile takes a RESOURCE id; scope still comes from construction |
| ✅ | 2 | Least-privilege turn scoping enforced (D-022) | 18 assertions, negative-controlled |
| 🟡 | 3 | web_fetch done (38 SSRF assertions); web_search is a seam awaiting a provider | tight on time |
| ⬜ | 4 | Cost/token dashboard | tight on time |
| ⬜ | 5 | Space view — force-directed, **SVG** (D-025) | first to go |
| ⬜ | 6 | Floating chat panels | first to go |
| ⬜ | 7 | Research tool, bounded multi-step | first to go |
| ❌ | — | Gmail | **already cut** — OAuth scope for no marginal signal |

### Submission

| ✔ | Item |
|---|---|
| ⬜ | README finished from the running `docs/DECISIONS.md` |
| ⬜ | `docs/AI-USAGE.md` finalised — generated vs hand-written vs **how checked** |
| ⬜ | Verify against a **clean browser session**, not a logged-in tab |
| ⬜ | Remove a member with the chat open in another window (**T11**) — the case most likely to contradict the README live |
| ⬜ | Repo public, deploy live, both verified from a cold machine |

---

## Cross-cutting invariants

True in every phase. Breaking one is a defect, not a tradeoff.

| Invariant | Enforced by |
|---|---|
| RLS on every table, in the creating migration | review + the migrations themselves |
| Service-role key read in exactly one file | `pnpm check:boundaries` |
| No memory query outside `lib/memory/retrieve.ts` | `pnpm check:boundaries` |
| Filter before rank | `private.memory_visible_in_chat()` — it is SQL, not application code |
| Audience evaluated against the snapshot | immutability test |
| Every agent action writes an event | append-only `agent_events`, no client write policy |
| Every model call writes a row, **before** the call | `llm_calls.status` + `finished_at` CHECK |
| No magic numbers outside `config/` | review + `tests/config.test.ts` |
| No `ScopedAgentContext` method takes a scope-defining id | dedicated test (Phase 2) |

---

## Open

| # | Question | Blocks |
|---|---|---|
| D-011 | Partial-turn resume semantics | nothing — **out of scope for v1**, stated |

Five limits the research could not close are at the foot of
[`docs/DECISIONS.md`](docs/DECISIONS.md). Read them before writing README prose,
so nothing is overclaimed.

---

## Legend

✅ done and proven · ⬜ not started · 🟡 in progress · ❌ cut
