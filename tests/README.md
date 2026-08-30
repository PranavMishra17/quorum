# Tests

> The brief asks for *"tests you consider important"*, not for coverage. So the
> organising principle here is: **every test defends a sentence the README
> asserts.** A test that does not defend a claim is probably not one of the
> important ones.

## Layout

Organised by claim, not by source file.

```
config.test.ts            passes today — see below
authorization/
  membership.test.ts      axis one: chat_members.status = 'member'
  clearance.test.ts       axis two: clearance level, plus group administration
memory/
  isolation.test.ts       THE TESTS THAT PROVE THE THESIS
  lifecycle.test.ts       candidate / active / superseded / stale, conflicts
agent/
  gate.test.ts            when the agent speaks and when it does not
tools/
  scoping.test.ts         a tool inherits the chat's authorization boundary
```

## Running

```bash
pnpm test          # once
pnpm test:watch    # watch mode
pnpm check         # boundaries + lint + tests, same as CI
```

## Current state

| | |
|---|---|
| Passing | `config.test.ts` — 35 assertions |
| `todo` | 102, across the six suites above |

The `todo` entries are not placeholders in the pejorative sense. They are the
test list from the README, committed as executable intent, so that the claims
and the suite cannot silently drift apart. Each becomes a real test in the tier
that implements the behaviour it defends (see [BUILD-PLAN.md](../docs/BUILD-PLAN.md)).

### Why `config.test.ts` is not filler

`config/models.ts` encodes API rules that are easy to get wrong from memory and
that fail at **runtime**, not at compile time:

- Passing `effort` to Claude Haiku 4.5 is a 400.
- Passing `thinking.budget_tokens` to any Claude 5-family model is a 400.
- A `max_tokens` above the model's ceiling is a 400.
- A large `max_tokens` without streaming hits the SDK's HTTP timeout.

The type system cannot catch a tier pointed at the wrong model. These tests can,
and they run without an API key.

They also pin the invariants the memory design depends on: the ranking weights
sum to exactly 1, the per-subject cap is meaningfully below the global cap, the
clearance ladder is strictly ascending (the floor comparison needs a total
order), and the gate biases toward silence.

## Two rules for this suite

**1. RLS is tested as an unprivileged role, never through a service-role client.**
That key bypasses the thing under test — a suite that uses it will pass against
a completely unprotected database. The `database` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) stands up a real
Postgres (`pgvector/pgvector:pg17`), applies the migrations, and connects as an
ordinary role with a JWT context set per test. Harness details are research
track R12.

**2. No test requires a live model call.** The supplied Anthropic key is
short-lived; a suite that stops working when a key expires is not a suite.
Anything needing a model is stubbed at the `lib/llm/provider.ts` boundary —
which is one of the reasons the provider sits behind an interface.

## Ordering: isolation tests come before retrieval

`tests/memory/isolation.test.ts` is written from the surfacing rule **as stated
in the README**, before `lib/memory/retrieve.ts` exists.

This is deliberate. A test written by reading the implementation will confirm
whatever the implementation does, including the wrong thing — and "the wrong
thing" here is a privacy leak that looks like a working demo.

## What is deliberately not tested

- **Coverage percentage.** Not a goal, not measured as one.
- **The model's prose.** Not deterministic, not worth asserting on.
- **The gate judge's exact verdict on ambiguous input.** The deterministic chain
  is tested exhaustively because it is deterministic; the judge is tested for
  its contract (schema shape, fail-closed on error), not its taste. How much
  further to go is research track R5.
