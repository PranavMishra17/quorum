# How AI tools were used

A running log, written as work happens rather than reconstructed at the end.
Marius asked for this explicitly and was direct about why: the worst pattern he
sees is engineers using AI for *thinking* rather than for *coding*.

So the honest framing for this project is:

> **The design was reasoned out first and then handed to the model as a
> specification.** The model was used for implementation speed — schema,
> boilerplate, prose, UI — and every authorisation and memory path is verified
> by tests written against the *rules*, not against the generated code.

That last clause is the one that matters. A test written by reading the
implementation will happily confirm a wrong implementation. The isolation tests
in `tests/memory/` are written from the surfacing rule as stated in the README,
before the retrieval code exists.

---

## Tooling

| Tool | Used for |
|---|---|
| Claude (Opus 5) via Claude Code | Scaffolding, config, documentation, implementation |
| Claude (chat) | Adversarial review of my own design |

---

## Log

### Session 1 — design, before any code

**Human.** The whole architecture. Specifically and importantly:

- Noticing that *"the agent learns useful information about users and can use it
  in future conversations"* invites a privacy leak. This is the central insight
  of the submission and it came from reading the brief, not from a model.
- The two-condition surfacing rule (audience containment **plus** clearance
  floor), including the argument for why the second condition is not redundant.
- `filter → rank → cap` ordering, and the reasoning that authorisation is not a
  relevance-ranking problem.
- `ScopedAgentContext` as the single agent read path.
- The two authorisation axes.
- The hybrid gate: deterministic chain first, model judge only for ambiguity,
  biased toward silence.
- Tests defined as claims-to-defend rather than coverage.
- The build tiering and the decision to schedule the decorative UI last.

**AI.** Adversarial review of the above, in a separate chat. This is worth
recording precisely because it is *not* the model doing the thinking — the design
existed first and was submitted for attack. What the review surfaced, and what
I did with each:

| Challenge raised | My response |
|---|---|
| "A class is not a security boundary — what stops a developer bypassing `ScopedAgentContext`?" | **Accepted.** Rewrote the claim as four layers (convention / application / RLS / tests) and made explicit that only RLS survives a bug in the application layer. Now stated that way in the README. |
| Authorisation under concurrency (TOCTOU) is undefined | **Accepted.** Logged as open decision D-009 and promoted to a top-priority research track (R2). Previously I had no defined answer. |
| Idempotency and duplicate agent turns unaddressed | **Accepted.** Logged as D-011, research R8, and added a `client_message_id` unique constraint to the schema. |
| Tool authorisation ≠ tool invocation permission | **Accepted.** The `Tool.execute` signature now takes `ScopedAgentContext` and cannot reach the database any other way, so resource-level authorisation is structural. Research R6. |
| Prompt injection via file/web tools | **Accepted.** Added an untrusted-content fence to `config/agent.ts` and the rule that tool output can never authorise a further privileged call. Research R7. |
| The knowledge graph is scope creep | **Accepted, provisionally.** Cut to a relational model (D-007), pending research R4 to justify it properly rather than just yielding to the criticism. |
| The UI scope is too large | **Already handled** — the canvas was already scheduled last. Reaffirmed as D-017. |

Two things I did *not* accept wholesale: the graph cut is held OPEN pending
research rather than taken on the reviewer's word, and the research list below
was re-derived rather than adopted verbatim — the reviewer's list omitted the
embedding-provider hole (D-004/R3), which is the only genuinely *blocking* gap
in the design.

### Session 2 — repository setup

**AI-generated, then reviewed by me:**

- Next.js scaffold (`create-next-app` — standard tooling, not a model).
- `config/models.ts`, `config/agent.ts`, `config/env.ts` — written by the model
  from my tier requirements.
- `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`,
  `docs/BUILD-PLAN.md`, `docs/SETUP-*.md`, `research/RESEARCH.md` — drafted by
  the model from my specification and my adversarial-review notes.

**How I checked it.** Specific claims, not vibes:

- **Model IDs and pricing were not taken from the model's memory.** They were
  pulled from a current reference, because model-name and pricing recall is
  exactly the kind of thing that is confidently wrong. One number that could not
  be sourced (Haiku 4.5's max output tokens) is marked `TODO(verify)` in the
  file rather than presented as fact.
- **The `budget_tokens` vs `effort` distinction was verified, not assumed.** The
  Claude 5 family rejects `thinking.budget_tokens` with a 400; depth is
  `output_config.effort`. A config written from stale training data would have
  produced a request shape that fails at runtime. Haiku 4.5 is the inverse — it
  rejects `effort` — and `config/models.ts` encodes both cases per model.
- `pnpm install`, `pnpm lint`, `pnpm build` run clean.
- Every doc was read end to end. Where the model asserted something I had not
  decided, it was either removed or moved to the OPEN list in `DECISIONS.md`.

**Not delegated.** The decision log entries' *reasoning* — the "why" in each
D-entry is mine; the model formatted it.

---

### Session 3 — test harness and CI

**AI-generated, then reviewed by me:** `vitest.config.mts`, `tests/setup.ts`,
`tests/README.md`, seven test files, `scripts/check-boundaries.mjs`, and
`.github/workflows/ci.yml`.

**Mine:** the decision that the test list is committed as executable `todo`
entries rather than written later. 102 todos, one per claim the README makes, so
the claims and the suite cannot silently drift apart. Also the decision that
`check-boundaries.mjs` should exist at all — it converts CLAUDE.md
non-negotiables 2 and 3 from things a reviewer must remember to look for into
things CI fails on.

**How I checked it.**

- `pnpm check` runs clean: boundaries pass, lint passes, 35 assertions pass.
- **The boundary checker found a real problem on its first run**, which is the
  best evidence that it works: `config/agent.ts` had `'memory_items'` as a
  context drop-order label, which is indistinguishable from a table name to any
  grep-based rule. I renamed the label to `'memory'` rather than loosening the
  rule — the checker was right that the string was ambiguous.
- I verified `config.test.ts` fails when it should, by temporarily breaking the
  ranking weights so they no longer sum to 1. A test suite never observed
  failing is not evidence of anything.
- The `database` CI job is written but skips itself until migrations exist, so
  it is honest rather than aspirational — it will not report green on work it
  did not do.

**Not delegated.** The two testing rules in `tests/README.md` — RLS tested only
as an unprivileged role, and no test requiring a live model call — are
constraints I set, and both exist for reasons specific to this project rather
than as general good practice.

### Session 4 — research, and the model auditing my own documents

**Mine.** The research plan itself — 16 tracks in three bands, each required to
name the decision it closes. The rule that **every report must end with the
strongest argument against its own recommendation**, because a report that only
supports its conclusion is confirmation, not research. And the orchestration
design: Sonnet does the legwork at effort graded by band, Opus is reserved for
two synthesis agents, and the highest-priority instruction given to the Band A
synthesiser was *"list what the research shows is wrong in README.md and
ARCHITECTURE.md."*

That last instruction is the point. It is cheap to use a model to generate
supporting material for a design you have already committed to. It is more useful
to point it at your own documents and ask what is false.

**AI-generated.** 16 research reports and 2 syntheses (~53,000 words, 18 agents,
2.1M tokens, zero failures).

**What it found — the reason this was worth doing.** Six defects in work I had
already written and was satisfied with:

| Found | Severity |
|---|---|
| README and ARCHITECTURE both said `ScopedAgentContext` "resolves **and holds**" the member set. Holding authorisation state across the model call **is** the TOCTOU gap. The docs instructed an implementer to build the exact bug the project claims not to have. | **Critical** |
| README: "Policies **deny** the authenticated role outright." Postgres has no deny policy. The outcome described was right, the mechanism named does not exist — and any interviewer who knows RLS would catch it. | High |
| README promised **semantic similarity** ranking. D-004 closed against wiring an embedding provider, so the shipped system would not have had it. An unmarked overclaim in the section a reviewer reads most closely. | High |
| Assumption 2 — "removed members lose access **from the moment of removal**" — is false as written. Realtime caches its RLS evaluation for the socket's lifetime, so a removed member with an open subscription keeps receiving messages. It would have failed live, on stage. | High |
| `config/agent.ts` budgeted the research tool at 180s inside a 60s tool loop. One of the two numbers was dead code. | Medium |
| `config/models.ts` set the deepest tier's timeout to exactly the platform invocation ceiling, leaving zero budget for the rest of the turn — and a function killed at the ceiling cancels its own deferred memory extraction. | Medium |

It also killed `judgeSpeakThreshold: 0.7`. LLM self-reported confidence is not
calibrated well enough to threshold on, so comparing a model-authored float to
0.7 was theatre. The README had said "a verdict plus a one-line reason" all
along — the prose was right and the config was wrong.

**How I checked it.** Not by trusting it.

- Every correction was checked against the primary source the report cited
  before I applied it. Where a report's *conclusion* survived but its
  *mechanism* did not — R5 recommended a forced tool call for the judge, which
  is superseded by structured outputs — I took the conclusion and rejected the
  mechanism.
- **I did not accept the graph cut just because it agreed with me.** D-007 was
  already leaning "cut", which is exactly when a confirming report is least
  trustworthy. What made it acceptable was that R4 tested a falsifiable bar —
  name three product queries a graph answers better — and reported finding one
  and a half, with the counter-evidence (Mem0ᵍ and Zep's temporal benchmarks)
  stated against itself. I also recorded that those numbers are **vendor
  self-benchmarks in both directions**, which is why D-007's rationale is logged
  at medium confidence even though its verdict is high.
- Where reports disagreed, I read both and ruled. R2 and R14 conflicted on
  whether to wrap a turn in one long transaction; R2 won on evidence, and R14's
  recommendation is narrowed rather than discarded.
- Five questions the research **could not** close are recorded as such in
  `DECISIONS.md` rather than papered over — including one (whether `auth.uid()`
  survives a `SECURITY DEFINER` role switch) that the entire membership-predicate
  design rests on, and which R1 honestly flagged it could not source. It is now
  scheduled as the first assertion in the RLS suite.
- Every config change is pinned by a new assertion in `tests/config.test.ts`
  (38 passing, up from 35), so the same mistakes cannot come back quietly.

**The honest summary.** The design survived. The *documentation of the design*
did not, and the gap between those two is where a take-home is actually lost.

### Session 5 — folding in the Band B/C findings

**The one that mattered.** The synthesis found a **fail-open in the project's own
central rule**. "Every active member of C2 was in the audience snapshot" is
*vacuously true* when C2 has no active members — `NOT EXISTS` over an empty set
in SQL, `Array.every` over an empty array in JavaScript. Implemented naively, a
fully vacated chat retrieves **every memory item in the system**.

That is the exact leak this project exists to prevent, arriving through the front
door of the rule that prevents it. I had written that rule, argued for it at
length, and not seen it. It is now the highest-priority test in
`tests/memory/isolation.test.ts`.

**Second-order finding worth recording** because the general literature does not
cover it: extraction runs on the model's own reply, so an injected instruction
that makes the model assert a false fact about a user **plants that lie into
memory**, where it surfaces — correctly authorised — indefinitely. Generic
injection analysis misses this because generic systems do not remember. Anything
extracted from a turn that touched untrusted content is now forced to `inferred`
and below threshold, landing as `candidate`.

**Also corrected:** `messages.turn_id` was missing, so the idempotency step had
nothing to return; `llm_calls` needed `status` + timestamps so the row can be
written *before* the billed call; the pipeline diagram implied an atomicity
`supabase-js` cannot deliver (no multi-statement transaction — it is now one
`SECURITY DEFINER` RPC); `getSession()` must be `getClaims()` server-side;
`middleware.ts` is `proxy.ts` in Next 16 and is UX, not a guard; and the space
view is SVG, not canvas.

**D-023 was resolved by asking rather than guessing.** The clearance rungs were
named for teams, which conflated "who is in the room" with "how sensitive the
material is" and produced a real ordering bug. I proposed three options; the
answer was that the team names were only ever examples of clearance levels, so
the ladder became pure sensitivity. Worth noting because the *research* found
the bug but could not have supplied the intent.

**How I checked the checker.** `scripts/check-boundaries.mjs` false-positived on
a JSDoc line that merely *mentions* `memory_items` while explaining the rule. I
fixed the comment stripper — and then verified with a **negative control**:
appended a genuine `supabase.from('memory_items')` call, confirmed it still
failed, and removed it. A validation script loosened without re-proving it still
catches the thing it exists to catch is worse than no script.

---

## Sessions to come

Entries will be appended per session with the same structure: what was
generated, what was hand-written, and specifically how the output was checked.

The checking commitments for the implementation phase, stated up front so they
can be held against me:

1. **Every RLS policy is read line by line before it is committed.** Generated
   SQL that *looks* right is the highest-risk artifact in this project.
2. **RLS is tested through an unprivileged role**, never through a service-role
   client — testing RLS with a key that bypasses RLS tests nothing.
3. **The memory isolation tests are written before `retrieve.ts` exists**, from
   the rule as stated in the README.
4. **No generated code involving the service-role key or a memory query is
   committed unread.** Those are the two paths where a plausible-looking
   generated line is a data leak.
