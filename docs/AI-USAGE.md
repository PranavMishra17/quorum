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
