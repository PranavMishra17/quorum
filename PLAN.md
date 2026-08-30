# Quorum — build plan and live status

**This file is the answer to "where are we?"** It is updated as part of the same
commit as the work it describes, so it is never stale. Detail lives in
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md); this is the map.

---

## At a glance

```
PHASE 1  MVP · submittable                    ██████████░░░░░░  ~60%   ← WE ARE HERE
PHASE 2  Memory + agent depth + polish        ██░░░░░░░░░░░░░░  ~15%
PHASE 3  Tools, capability, polish, submit    ░░░░░░░░░░░░░░░░    0%
```

**Right now:** the database layer and the client trio are done — 9 migrations,
158 assertions, CI green. `ScopedAgentContext` exists and its capability
invariant is enforced by a test, verified by negative control.

**Immediately next:** Google auth + seeded dev login → chat list UI.

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
| ⬜ | `proxy.ts` — UX redirect only, **not** a guard (**T7**) | documented + no authz decision in it |
| ⬜ | `app/auth/callback/route.ts` — PKCE, `no-store` (**T8**) | header asserted |

### 1.3 Auth and identity — **NEXT**

| ✔ | Item | Proof |
|---|---|---|
| ⬜ | Google OAuth end to end | sign-in works on the deployed URL |
| ⬜ | Seeded dev login, hard-gated to non-production | boundary-checker rule; 5 users with preset clearances |
| ⬜ | Profile bootstrap on first sign-in | a new user gets a row |

### 1.4 Chat surface

| ✔ | Item | Proof |
|---|---|---|
| ⬜ | Chat list (the permanent fallback UI — D-017) | two sessions converse, a third sees nothing |
| ⬜ | Message list + composer, optimistic send | reconciles against the persisted row |
| ⬜ | Realtime subscription | new messages arrive without reload |
| ⬜ | Message rendering: human left, agent right, per-user colour | agent is never mistaken for a person |
| ⬜ | Output sanitisation at render (**R7 — Phase 1, not 3**) | no auto-loading remote images; link beacons blocked |

### 1.5 The agent speaks

| ✔ | Item | Proof |
|---|---|---|
| ⬜ | `lib/llm/provider.ts` interface + `errors.ts` typed union | swapping providers is one file |
| ⬜ | `lib/llm/anthropic.ts`, SDK at `maxRetries: 0` (**T9**) | a model call produces an `llm_calls` row |
| ⬜ | `llm_calls` written **before** the call | a killed call still leaves a row |
| ⬜ | `lib/events/log.ts` append-only writer | every agent action writes an event |
| ⬜ | `lib/agent/gate.ts` — deterministic chain, rules 1–6 | pure, unit-tested, no DB |
| ⬜ | Gate judge, discrete verdict (D-020) | fails closed on error/timeout/malformed |
| ⬜ | `lib/agent/orchestrator.ts` — the turn pipeline | agent answers when mentioned, silent in an unaddressed DM |

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
| ⬜ | `lib/memory/audience.ts` — snapshot writer | snapshot is immutable after write |
| ⬜ | `lib/memory/retrieve.ts` — filter → rank → cap | the **only** memory query site |
| ⬜ | Ranking: `ts_rank` + recency + speaker presence (D-004) | weights sum to 1, already asserted |
| ⬜ | Per-subject cap | one person cannot crowd out nineteen |
| ⬜ | `lib/memory/extract.ts`, deferred via `after()` (D-013) | runs after delivery, never inline |
| ⬜ | Untrusted-turn policy → `inferred` + `candidate` (**T10**) | a planted fact is never retrieved |
| ⬜ | `lib/memory/conflict.ts` — deterministic, never the model (D-014) | stated > inferred; newer > older; ties write an event |
| ⬜ | `ScopedAgentContext` re-reads authz per call (**T2**, D-009) | a mid-turn removal takes effect on the next read |
| ⬜ | Group admin: invite, request, approve, remove, promote | non-admin refused (partly covered) |
| ⬜ | Realtime channel force-close on removal (**T11**) | removed member stops receiving live |
| ⬜ | **Agent internal view** — the single best demo artifact | shows retrieved *and filtered-out* counts |
| ⬜ | Token + cost accounting per chat and globally | reads from `llm_calls` |

**Phase 2 exit gate:** the thesis is provable **and visible on screen**. A memory
isolation rule you cannot see working is indistinguishable from one that does
not work.

---

## Phase 3 — Tools, capability, polish, submission

*Everything here is cuttable, in this order, without touching anything above.*

| ✔ | Priority | Item | Cut if |
|---|---|---|---|
| ⬜ | 1 | File upload + read tool | never — cheapest tool, proves resource-level authz |
| ⬜ | 2 | Least-privilege turn scoping enforced (D-022) | never — it is the injection claim |
| ⬜ | 3 | Web search tool, results summarised not dumped | tight on time |
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
