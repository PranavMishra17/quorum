# Build plan

**12 hours**, starting once research is complete and the open decisions in
[DECISIONS.md](DECISIONS.md) are closed.

Three tiers. The ordering rule is that **running out of time must degrade the
demo, not the substance** — so everything graded sits ahead of everything
decorative, and each tier ends at a state that could be submitted as-is.

| Tier | Hours | Ends at |
|---|---|---|
| **1 — Submittable** | 0–5 | A deployed, working, authorised multi-user chat with an agent that decides when to speak. Could be handed in. |
| **2 — Depth** | 5–10 | Memory, authorisation, and agent behaviour done properly, with the tests that prove it and the internal view that shows it. This is where the grade is. |
| **3 — Reach** | 10–12 | Tools, the space view, cost dashboard. Pure upside. |

---

## Hour 0 — deploy an empty skeleton

Before anything else, and it is not negotiable: **push to GitHub, import to
Vercel, deploy the scaffold, confirm the URL loads.**

Hosting surprises found at hour eleven are fatal. Found at hour zero they are
trivia. Same for the Supabase project, the Google OAuth client, and the redirect
URLs — all of it is configuration that fails in boring, time-consuming ways.

Follow [SETUP-SUPABASE.md](SETUP-SUPABASE.md) then [SETUP-VERCEL.md](SETUP-VERCEL.md).

---

## Tier 1 — Submittable MVP (hours 0–5)

Goal: **every literal requirement of the brief is met.** Any number of users;
DMs and groups with 2+ members; an agent in every chat; users can only access
chats they belong to; the agent decides whether to respond; persistence exists;
authentication is simplified and authorisation is meaningful.

| Hours | Work | Done when |
|---|---|---|
| 0–1 | Supabase project, Google auth, migrations `0001`–`0004`, deploy skeleton | Sign in with Google works on the deployed URL |
| 1–2.5 | Chats, members, messages. RLS policies **written and read line by line**. List-based UI. | Two browser sessions can hold a conversation; a third cannot see it |
| 2.5–3.5 | `lib/llm/provider.ts` + `anthropic.ts`, `llm_calls` recording, `lib/events/log.ts` | A model call happens and produces a cost row |
| 3.5–5 | Gate chain (rules 1–6) + judge, agent responds, `agent_events` written | Agent answers when mentioned; stays silent in a DM it was not addressed in |

**Tier 1 exit gate.** Deployed. Two real users. Agent speaks appropriately.
A non-member gets nothing. If everything after this failed, this would still be
a defensible submission.

Memory in tier 1 is deliberately **absent, not half-built** — a half-built
memory system with no isolation is worse than none, because it demonstrates the
exact leak the project claims to solve.

---

## Tier 2 — Depth (hours 5–10)

Goal: the three things actually being graded — memory, agent behaviour, and
authorisation — done thoroughly and *visibly*.

| Hours | Work | Done when |
|---|---|---|
| 5–6 | Migration `0006`: `memory_items`, `memory_audience`, deny-all RLS. Audience snapshot writer. | Memory tables exist and are unreachable from the client |
| 6–7 | **Memory isolation tests, written first**, from the rule as stated in the README | The five isolation tests exist and fail |
| 7–8.5 | `retrieve.ts` (filter → rank → cap), `extract.ts` (deferred), `conflict.ts` (deterministic) | The isolation tests pass |
| 8.5–9.5 | Clearances, admin roles, join requests, RLS hardening, authorisation tests through an unprivileged role | A member without clearance cannot read a gated chat; a removed member loses history |
| 9.5–10 | Agent internal view: gate decisions, memory retrieved **and filtered-out counts**, conflicts, dropped context, token spend | The filter is visibly doing something in the UI |

**Tier 2 exit gate.** The thesis is provable, and provable *on screen*. A memory
isolation rule you cannot see working is indistinguishable from one that does
not work — which is why the internal view is in tier 2, not tier 3.

Note the ordering of 6–7 and 7–8.5. The tests come before the implementation
because a test written by reading the implementation confirms whatever the
implementation does, including the wrong thing.

---

## Tier 3 — Reach (hours 10–12)

Everything here is cuttable, in this order, without touching anything above.

| Priority | Work | Cut if |
|---|---|---|
| 1 | File upload + read tool, with the cross-chat isolation test | never — it is the cheapest tool and it proves resource-level authorisation |
| 2 | Web search tool, results summarised into context | tight on time |
| 3 | Cost/token dashboard | tight on time |
| 4 | Force-directed space view, floating chat panels | first to go |
| 5 | Research tool (bounded multi-step) | first to go |
| — | Gmail | **already cut** — OAuth scope complexity for no marginal signal |

---

## Hours 11–12 — write-up and verification

Reserved, not optional. The README and the AI-usage note are **graded
artifacts**, not packaging.

- README finished from the running [DECISIONS.md](DECISIONS.md).
- [AI-USAGE.md](AI-USAGE.md) finalised: generated vs hand-written vs how checked.
- Verify against a **clean browser session** — a fresh profile, not a logged-in
  tab. Half of all auth bugs only appear this way.
- Verify the isolation claims by hand, in the UI, as a second pair of eyes on
  the tests.

---

## The extensibility constraint

Tier 3 must never force a tier 1 rewrite. That is a property of the seams, not
of discipline, and the seams are listed in
[ARCHITECTURE.md § 5](ARCHITECTURE.md#5-what-makes-this-extensible).

The concrete commitments:

- **A new tool is one file.** It receives `ScopedAgentContext` and cannot reach
  the database any other way, so it inherits authorisation instead of
  re-implementing it.
- **A new event type is a string plus a payload shape.** `agent_events.payload`
  is jsonb; no migration.
- **A new model or provider is one file** behind `lib/llm/provider.ts`.
- **Migrations are additive.** Never edit one that has run.
- **Ranking can change without touching filtering.** This is what makes the
  open embedding decision (D-004) deferrable rather than blocking — the
  authorisation filter is set containment plus an integer comparison and is
  correct under any ranker.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Anthropic key expires or rate-limits mid-build | high | `AGENT_ENABLED=false` degrades to plain chat, no redeploy. Provider behind an interface. Retries capped at 1. |
| RLS policy recursion through `chat_members` | high | Membership predicate as a `security definer` function. Known footgun — research R1. |
| Google OAuth redirect misconfiguration | medium | Done at hour 0 on the deployed URL, not localhost only |
| Serverless timeout on the agent turn | medium | Extraction deferred; streaming response; tool loop hard-capped |
| Memory extraction produces junk | medium | Confidence threshold; sub-threshold items land as `candidate` and are never retrieved |
| Scope creep into the canvas UI | medium | It is scheduled last and the list view is the permanent fallback |
| Generated RLS that looks correct but is not | high | Read line by line; tested through an unprivileged role |
