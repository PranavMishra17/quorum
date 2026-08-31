# Quorum — build plan and live status

**This file is the answer to "where are we?"** It is updated as part of the same
commit as the work it describes, so it is never stale. Detail lives in
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md); this is the map.

**Live:** <https://quorum-rho.vercel.app> · Repo:
<https://github.com/PranavMishra17/quorum> ·
**Verify it yourself:** [`docs/VERIFY.md`](docs/VERIFY.md)

---

## At a glance

```
PHASE 1  MVP · submittable                    ████████████████  100%  DONE
PHASE 2  Memory + agent depth + polish        ████████████████  100%  DONE
PHASE 3  Tools, capability, polish, submit    ████████████████  ~98%  ← WE ARE HERE
```

**Right now:** Phase 3. Every tool that was in scope is built, floating panels
shipped, and the old full-page chat route was folded into Rooms. What remains
is the submission itself, plus one decorative item (the space view) that was
always first to go.

**Phase 1 is closed.** It was carried at ~90% for two reasons, both now
resolved: `lib/db/types.ts` was a hand-written placeholder, and Google sign-in
had never been exercised end to end. Types are generated from the linked
project — and immediately caught four mismatches the placeholder had been
papering over. The auth flow is provisioned, its unauthenticated half is
verified against production, and the signed-in half is scripted in
[`docs/VERIFY.md`](docs/VERIFY.md).

**Verification is now two things, not one.** `pnpm test` proves the POLICIES
against a real Postgres. `pnpm verify:live` drives a real browser and proves the
APPLICATION asks the database the right questions — a distinction that earned
its keep immediately by finding three bugs every database test passed. See
[Verification](#verification).

**Deployed and partly verified against production.** Supabase is provisioned,
migrations are applied, Google auth is configured, and Vercel is live. The
unauthenticated half of the authorisation story is now **observed, not claimed**:

| Checked against production | Result |
|---|---|
| `/chats` while signed out | 307 → `/?next=%2Fchats` |
| `/auth/dev?user=alice` | **404** — the three-way dev-login gate holds |
| `/auth/callback` headers | `private, no-store, max-age=0, must-revalidate` (**T8**) |
| `POST /api/chats`, `/api/clearances` unauthenticated | 401 |
| Landing page | renders the app, not the setup notice |

Authenticated flows need a browser and a Google account, so they are yours to
run — [`docs/VERIFY.md`](docs/VERIFY.md) is the script, with expected results
**and what failure looks like** for each claim.

**Phase 2 sanity check** found one real gap and two usability blockers, all now
closed:

| Found | Status |
|---|---|
| `user_clearances` had **no write path at all** — a fresh user held nothing, could not see or create a gated chat, and axis two was unreachable outside the seed script | ✅ `grant_clearance` / `revoke_clearance` (0012) + a People page. 16 assertions. |
| The first user in an empty workspace could never be granted anything — nobody held a clearance to grant from | ✅ `claim_base_clearance()` hands out the level-0 rung only, which gates nothing |
| `pnpm dev` on a fresh clone threw out of the env schema | ✅ renders a setup page instead |

**Immediately next:** the submission — README, `docs/AI-USAGE.md`, and walking
`docs/VERIFY.md` end to end on the deployed URL from a cold browser session.

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
| ✅ | `lib/db/types.ts` — generated from the linked project | generated; caught four call-site mismatches the placeholder had hidden. Aliases derive from it in `lib/db/rows.ts` |
| ✅ | `proxy.ts` — UX redirect only, **not** a guard (**T7**) | Next recognises it; no authz decision in it |
| ✅ | `app/auth/callback/route.ts` — PKCE, `no-store` on every path (**T8**) | open-redirect guarded |

### 1.3 Auth and identity — **COMPLETE**

| ✔ | Item | Proof |
|---|---|---|
| ✅ | Google OAuth end to end | provisioned and configured; the callback is verified against production (`private, no-store`, open-redirect guarded). The click itself needs a human with a Google account — scripted in `docs/VERIFY.md` |
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

**Phase 1 exit gate — MET.** Deployed; two real users converse; the agent
speaks appropriately; a non-member gets nothing. Confirmed by
`pnpm verify:live`: 20/20, including a non-member receiving a 404 that does not
even name the chat.

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
| ✅ | 1 | File upload + read tool | `ctx.readFile` takes a RESOURCE id; scope still comes from construction |
| ✅ | 2 | Least-privilege turn scoping enforced (D-022) | 18 assertions, negative-controlled |
| 🟡 | 3 | `web_fetch` done (38 SSRF assertions); `web_search` is a seam awaiting a provider | tight on time |
| ✅ | 4 | **PDF + DOCX extraction** | 18 assertions against genuine PDF and `.docx` bytes, built in the test rather than committed as binaries |
| ✅ | 5 | **Structured extract-to-schema** — `document_extract` | 20 assertions. Every quote is verified against the document; unverified findings are marked, not dropped |
| ✅ | 6 | **Gmail connector, read-only** — [`docs/EMAIL-SETUP.md`](docs/EMAIL-SETUP.md) | 52 assertions, 23 against real Postgres. Encrypted at rest, RLS with zero policies, negative-controlled |
| ✅ | 7 | **Calendar (read-only)** — same OAuth client and consent screen | window bounded; attendees counted, never named |
| ✅ | 8 | **Research turn** — bounded, multi-step, user-invoked (`/research`) | 24 assertions, several of them source-level checks that the second turn type did not quietly drop a control |
| ✅ | — | Cost/token dashboard | shipped in Phase 2 |
| ✅ | — | Internal view renders tool and research events | a blocked exfiltration attempt is now one readable line, not raw JSON |
| ✅ | — | **Front-end rebuild** — the redaction identity, workspace home, directory, account and admin pages | see below |
| ⬜ | 9 | Space view — force-directed, **SVG** (D-025) | first to go — the workspace grid now does its job |
| ✅ | 10 | **Floating chat panels** — pop a chat out into a draggable, resizable window; minimize to a dock; multiple at once, capped at 4 | scoped as decorative from the start; session-only via `sessionStorage`, no durable layout |

### The FE functional pass — inline telemetry, floating panels, and what running the app found

A sanity check against `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and
`docs/MEMORY.md`, plus actually driving the running app with Playwright rather
than reading the components. Two things landed, and two real bugs were found
doing it — the second pair matters more than the feature work, per the
project's own stated priority (T12: a thing that looks right in code and has
not been run is not verified).

**Inline live telemetry.** The agent's thinking and actions now render directly
in the chat viewport, not only in the collapsed `InternalView` panel: a live
"thinking…/composing a reply…/using file_read…" status line under the message
that triggered a turn, settling into a one-line summary (`mentioned · 2660 tok
· $0.0102`) with the full ordered event trace one click away — including a
silent turn's reason, shown under the user's own message since no agent reply
exists to hang it on. `app/_components/event-trace.ts` is the shared
`describeEvent`/`summariseTurn` module both this and `InternalView` render
through, specifically so the wording can never disagree between the two.

**Slash-command discovery.** Typing `/` in the composer now opens a popup
listing available commands (`/research <question>`, extensibly — one array
entry per command, not a new branch of JSX), rather than requiring a user to
already know the command exists.

**Floating chat panels.** A chat can be popped out of the list or the full page
into a draggable, resizable overlay window — reusing `ChatSurface` itself
rather than a parallel implementation, so a fix to the chat surface is a fix
everywhere it renders. State lives in React context + `sessionStorage`, capped
at 4 concurrent panels (each holds its own Realtime subscriptions).

**Found by running it, not by reading it:**

| Found | Fix |
|---|---|
| `cannot add postgres_changes callbacks ... after subscribe()` — a real Supabase Realtime race against Next dev's double-invoked effects. The second mount's `.channel(topic)` call, issued before the first mount's async `removeChannel()` leave had resolved, got handed back the ALREADY-SUBSCRIBED first instance instead of a fresh one. Crashed the chat page outright the moment a message was sent | Every Realtime topic now carries a random suffix per effect invocation, so two overlapping mounts can never collide on the same topic. Applied to all four subscription sites (`chat:`, `membership:`, `events:`, `turn:`) |
| The inline trace's cost/token line was always blank — `TurnTrace` was never given `llm_calls` rows to join against, only `agent_events` | Threaded `initialCalls` through `ChatSurface` → `MessageRow` → `TurnTrace`, from both the server-rendered chat page and the floating panel's client-side loader |
| The slash-command popup rendered **behind** an open floating panel — the panel host sits at `z-40`, the popup had no explicit z-index | `z-50` on the popup |

### The front-end rebuild — the redaction identity

The UI was a generic dark dashboard that could have belonged to any product. It
now has one idea, and the idea is the thesis.

**Colour means clearance, and nothing else.** Four hues exist — the four rungs
of the ladder — so a colour anywhere on screen answers exactly one question. No
primary blue, no accent links: primary actions invert to ink-on-paper instead.
The single exception is a person's own identity colour, on their avatar and
their name, because people are not a sensitivity level.

**The signature is `--ink`** — the only pure black in the palette, used for
exactly two things: the Q tile, and a redaction bar. Because nothing else is
that black, "you cannot see this" reads without a label.

**The redaction is honest.** `<Redacted>` takes a WIDTH, not content — there is
deliberately no way to pass it something to hide, because every CSS mechanism
for hiding text still ships that text to view-source, the clipboard and a screen
reader. For a product claiming unauthorised content never reaches the client, a
redaction you could select and copy would be the worst possible bug. The server
never sends the names; the bar draws the hole they left. Asserted by the live
driver against the page's own HTML.

What that produces: a group you are cleared for but not in shows its NAME (so a
join request is possible at all) with its roster as redaction bars. Same tile,
same size, same place in the grid — the difference is not that it matters less,
it is that it is withheld. A group above your clearance is not there at all: not
greyed, not locked, not counted, because a count leaks the fact the rule
protects (D-027).

| Built | Notes |
|---|---|
| Workspace home | Search hero, Q as a two-column ink tile inside the people grid — the agent on the same footing as everyone else, not a bolted-on "Ask the AI" panel. `q` opens it, `/` focuses search |
| Directory + click-to-DM | `POST /api/dm` is find-then-create. Without the find, clicking twice makes a SECOND DM with the same person — and a memory learned in one is authorised in the other, so "our conversation" silently splits across two rooms |
| Groups grid | Member tiles list people; discoverable tiles redact them; join requests inline |
| Account page | The whole ladder, held and unheld, because "what am I missing" is the useful question. It does not say what the missing rungs would reveal — that would be the disclosure D-027 prevents |
| Admin mode | Dev-only, **three independent gates**, audited. See below |
| Floating panels | Full-screen toggle, drag, resize, minimise dock |
| Message styling | Agent right in ink-edged monochrome, people left in their own colour — two axes of difference, so it survives a glance and a colour-blind reader |

**Admin mode is gated in the database, not just the app.** An env-var check in a
route handler would have left a permanent escalation RPC in production, callable
by anyone holding the publishable key — which ships in the browser bundle. So:
the app requires non-production plus an explicit flag; the route holds a secret
the browser never sees; and the SQL refuses unless `private.admin_mode_secret`
holds a matching row, a table migration 0016 creates EMPTY. Pushing it to
production leaves admin mode dead on arrival. Every action writes its own audit
row from inside the function, so it cannot be skipped — the first draft wrote
the audit from the route into `agent_events`, a table with no client insert
policy, where it failed silently and would have shipped claiming a trail that
did not exist.

### Second FE pass — memory subject-access, Gmail wired up, and the group-creation fix

Six more items from a direct usability pass, plus one migration mistake corrected.

- **The agent now answers to Q reliably**, and the `@` mention menu lists it
  once instead of three ways to say the same thing (`@quorum`/`@agent`/`@q`
  still all work — see the previous entry — the menu just does not advertise
  all three).
- **A real flex-layout bug, not a styling one.** The rooms page and floating
  panels were spilling down the page instead of scrolling internally. Cause:
  a flex item's default `min-height: auto` refuses to shrink below its
  content, so `flex-1 overflow-y-auto` inside a capped-height flex column does
  not scroll — it grows and pushes the cap. `min-h-0` on every scrolling
  ancestor fixes it. Worth naming because it is exactly the kind of bug that
  looks like a Tailwind class was forgotten and is actually a CSS mechanics
  fact.
- **Memory, as a page.** `public.my_memory()` (migration 0019) is the one
  read path into `memory_items` that is not the agent's: a person may read
  rows where THEY are the subject, and nothing else. It deliberately IGNORES
  the surfacing rule — a fact learned about you in a room you have since left
  is still shown, because "what does it know about me" and "what may it say in
  this room" are different questions that disagree on purpose for the same
  row. 21 assertions against real Postgres, including that an empty audience
  does NOT blank the subject's own view (the mirror image of the T1 trap).
- **Gmail/Calendar wired up locally**, and the redirect URI + encryption key
  filled in. What is left is entirely on Google's side — enabling both APIs,
  adding both scopes to the consent screen, listing the redirect URI, adding
  a test user — and the Capabilities page now says so as a checklist rather
  than leaving a developer to guess which Console tab to open next.
- **Group creation is groups-only now.** It used to offer DM and solo-agent
  chat types in the same form, which meant the first decision was "which of
  three things am I making" for two of which a dedicated affordance (click a
  person; the Q tile) already existed. Clearance is now a stamp picker instead
  of a `<select>`, matching the one visual grammar the whole redesign runs on,
  and selected people stay visible as removable chips instead of disappearing
  into a scrolled checklist.
- **A migration's own reasoning corrected in the next one.** 0017 auto-joined
  new signups to ungated groups but declined to backfill existing accounts,
  reasoning that it might rewrite `memory_audience` snapshots. That reasoning
  was wrong, in the safe direction: snapshots are never rewritten, and a new
  member simply falls outside every old one — the room forgets things for
  them, which is the rule working, not a leak. 0018 backfills, and says which
  of the two migrations was mistaken rather than silently reversing it.

### What each tool cost in capability

Worth stating, because in every case the easy version would have been a better
demo and worse engineering:

| Tool | The constraint it accepted |
|---|---|
| `file_read` | A PDF with no text layer is a REFUSAL with a reason. Returning `''` would read to the model as "this document is blank" — a materially wrong answer to give about a contract |
| `document_extract` | Quotes are checked against the document. A fabricated quote is more dangerous than a fabricated value, because it carries the visual grammar of evidence |
| `email_search` | Headers and snippets only, never bodies. DMs and agent chats only, enforced at REGISTRATION — in a group the model is never shown the tool, rather than shown it and asked to decline |
| `calendar_list` | Attendees are counted, not named. The count answers "is this a big meeting"; the names are other people's data reaching a chat none of them are in |
| `/research` | Inherits D-022 unchanged. Read a contract and it can no longer fetch a page about it. The alternative was a research-specific exemption — which is how a least-privilege rule acquires an exception for the one case that matters |

### Found while building these

| Found | Fix |
|---|---|
| `toolDefinition` described **every** input property as a string. Fine for three tools with one string input between them; wrong the moment one took an array. The model would have sent a string and had it rejected by the schema that had just described it — and the symptom is a model that merely *appears* not to use its tools well | `z.toJSONSchema` over the same object that validates the input, so the description and the enforcement cannot disagree |
| The turn route declared `maxDuration = 60` while `TIERS.reason` budgeted 240s and research 180s — both budgets for a container four times larger than the one they ran in, and `after()` work counts toward that duration | One number, `PLATFORM.turnRouteMaxDurationSeconds`, asserted against every tier and against research |
| `googleapis` was a dependency for four endpoints | Removed. Plain `fetch`: the request that goes out is the request you can read |

### Rooms consolidation, docs sanity check, and a landing-page copy pass

- **The full-page chat route is now a redirect, not a page.** `/chat/[chatId]`
  used to render its own copy of chat + roster + internal view. Rooms
  (`/people`) grew the same three things side by side once it existed, which
  made the full page a second way to reach the same data rather than a
  distinct feature — so it is now `redirect('/people?open=' + chatId)`, and
  every link that used to point at it (pop-outs, the account page's group
  list, the memory page's origin-chat link) points at `?open=` instead. Roster
  actions (promote/remove/approve/leave) needed their own refetch trigger
  added, since Rooms loads its data client-side and `router.refresh()` alone
  only re-renders the server-fed room *list*, not an already-open pane.
- **`docs/DECISIONS.md` had three stale headings.** D-004, D-007 and D-009
  each said **OPEN** in the heading while their own `**Status.**` line, a few
  paragraphs down, said CLOSED — found by a direct sanity check against
  `CLAUDE.md`'s summary table, which had always treated them as settled. Fixed
  to match the body, which was correct all along.
- **`docs/ARCHITECTURE.md` had drifted from the code it describes** — wrong
  migration range, tool files that were renamed or never existed
  (`web-search.ts`, `file-read.ts`), a route (`api/agent/turn/route.ts`) that
  was never built because the turn runs in `after()` instead, and no mention
  at all of memory subject-access, connectors, admin mode, or the demo world.
  Rewritten against the actual `lib/`/`app/`/`supabase/migrations/` trees
  rather than patched line by line.
- **Landing page copy rewritten.** The two-column explainer used to narrate
  the take-home's own framing back at the reader (*"the leak the brief
  invites"*), and the sign-in panel said outright that authentication was the
  easy part — both read like notes to a grader, not product copy, and neither
  belongs on a page a real user would land on. Replaced with copy about what
  the product actually does; the visual design (the redaction system, the
  two-room demonstration) is unchanged.

### Demo layer — BUILT (migration 0020)

Landed leaner than scoped, deliberately: two rooms with ONE seed message
between them, not four rooms with scripted back-and-forth. Every reply after
that message is the real agent, on the real pipeline, with real telemetry —
there is no standing mechanism anywhere in this codebase for posting a message
on another user's behalf, and there deliberately never will be. See migration
0020's own header for the rejected wider design and why it was rejected.

| Piece | What it does |
|---|---|
| Two personas, real accounts | "Priya" and "Sam" — genuine `auth.users` rows (every identity column in this schema is a real FK, so there is no lighter-weight fake person), created once via `pnpm seed:demo-personas`. `profiles.is_demo` excludes them from the Directory, New group, and clearance-granting lists at the application layer |
| `ensure_demo_world()` | SECURITY DEFINER, no parameters, idempotent. Runs on every sign-in (after `ensureProfile()`). Creates a DM with Priya (one backdated seed message, a real PDF attached in a follow-up Node step since Storage cannot be written from SQL) and a group with Priya + Sam (deliberately NO seed message — its only job is to be a room Priya was in and Sam was not) |
| The memory demo, for real | Tell the agent something in the Priya DM, then ask the same question in the Team Sync group. The withholding is not staged — the model call is real, and it genuinely does not know, because the fact was never retrieved into that room's context |
| Suggestion chips | Canned strings shown above the composer in demo rooms. Tapping one sends it through the ORDINARY send path — same idempotency RPC, same gate, same everything. A chip is a keyboard shortcut, not a second code path |
| Visibly marked, everywhere | A `DemoStamp` component, identical on the Rooms list, a chat header, the Workspace groups grid, and a floating panel — one component so the wording can never drift between surfaces |
| Reset | `POST /api/demo/reset` deletes and rebuilds the caller's own two rooms. Takes no id; can only ever touch chats where the caller is a member and `is_demo = true` |

Auto-join exclusion was the sharpest correctness risk: without it, migration
0017's "join every new signup to ungated groups" trigger would pull EVERY new
user into the FIRST user's demo group, since it is `type='group'` with no
clearance requirement — destroying the entire "Sam was not in the room"
premise. Migration 0020 redefines that trigger to exclude `is_demo` chats.
Proven with a negative control: removing the exclusion makes exactly one test
fail, and it is the one asserting a third signup stays out of an earlier
user's demo group.

24 assertions (18 SQL-level + suggestion/catalogue coverage), two negative
controls, and 12/12 in a live browser against the real deployed database —
including tapping a suggestion, watching the agent genuinely not know a fact
in the wrong room, and a full reset-and-rebuild cycle.

### Submission

| ✔ | Item |
|---|---|
| ⬜ | README finished from the running `docs/DECISIONS.md` |
| ⬜ | `docs/AI-USAGE.md` finalised — generated vs hand-written vs **how checked** |
| ⬜ | Walk [`docs/VERIFY.md`](docs/VERIFY.md) end to end on the deployed URL |
| ⬜ | Verify against a **clean browser session**, not a logged-in tab |
| ⬜ | Remove a member with the chat open in another window (**T11**) — the case most likely to contradict the README live |
| ⬜ | Repo public, deploy live, both verified from a cold machine |
| ⬜ | `supabase db push` for migration `0014`, then regenerate types and delete `lib/connectors/rpc.ts` — it names its own removal |

---

## Verification

Two commands, proving two different things. Conflating them is the mistake
`pnpm verify:live` exists to prevent.

| | Proves | Does NOT prove |
|---|---|---|
| `pnpm test` — 626 passing, 17 todo | The POLICIES, against a real Postgres 18.4, as an unprivileged role | That the application asks the right questions |
| `pnpm verify:live` — 20/20 | What a real signed-in user SEES in a browser, including full memory isolation with real model calls | The policies themselves — it sees only what the app chose to ask for |

The distinction is not academic. `verify:live` found three bugs that every
database test passed, because every policy involved was correct:

- **A blank optional env var killed every agent turn.** `.env.example` ships
  `SEARCH_API_KEY=`; `.optional()` admits `undefined`, not `''`. `serverEnv()`
  threw inside `after()`, so the message persisted, the POST returned 201, and
  no reply ever arrived — with nothing in `agent_events`, because the throw
  preceded the first event write.
- **A PostgREST embed that could never resolve, with its error discarded.**
  `chat_members.user_id` references `auth.users`, so `profiles:user_id(...)` has
  no foreign key to resolve through. Pages destructured only `{ data }`, making
  a *failed* query indistinguishable from an *empty* one — the chat page
  concluded Alice was not a member of her own DM.
- **Anthropic rejects `maxItems` / `minimum` / `maxLength` in structured
  outputs.** A 400 that failed every extraction call, so every turn silently
  learned nothing while the replies looked fine.

And plainly: **a green `pnpm test` is not evidence the authorisation claims
hold** (T12). Without `DATABASE_URL` the database suites *skip*, and a silent
skip is indistinguishable from a pass.

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
