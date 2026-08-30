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
pnpm test          # everything, including the RLS suites
pnpm test:watch    # watch mode
pnpm check         # boundaries + lint + tests, same as the CI `check` job
```

No setup, no Docker, no `DATABASE_URL`. `pnpm test` starts a real Postgres,
applies every migration, and runs the authorization suites against it.

### The harness

Docker is not installed on the development machine, so `tests/global-setup.ts`
starts **PostgreSQL 18.4 via `embedded-postgres`** — genuine Postgres binaries,
no container. The alternative, an in-JS Postgres emulator, does not implement
row-level security, and RLS is the thing under test: a harness that cannot
enforce a policy cannot verify one.

`tests/db/auth-shim.sql` recreates just enough of Supabase's `auth` surface —
`auth.users`, `auth.uid()` reading `request.jwt.claims`, the
`anon`/`authenticated`/`service_role` roles — that the **real migrations run
unmodified**. Policies rewritten to suit the test environment would be testing
something other than what ships.

It also reproduces Supabase's **default privileges**, and that detail decides
whether any of this means anything: in a real project `authenticated` *does*
hold table grants and RLS narrows them. Without the grants, a policy test would
pass because the role lacked privilege rather than because the policy denied the
row — every test green, none testing RLS.

Three connection factories in `tests/db/harness.ts`:

| | Use |
|---|---|
| `asUser(id)` | role `authenticated` + JWT claims. **Assert with this.** |
| `asAnon()` | signed out. **Assert with this.** |
| `asSuper()` | superuser. **Fixtures only** — it bypasses RLS, so an assertion through it proves nothing. |

The first run initialises the data directory (~15s); later runs reuse it. The
schema is dropped and rebuilt from the migrations every run, so no state carries
between runs and a migration that only works against a warm database fails here
rather than on deploy.

## Current state

| Suite | Passing |
|---|---|
| `config.test.ts` | 42 |
| `authorization/rls-foundation` | 13 |
| `authorization/membership` | 17 |
| `authorization/clearance` | 11 |
| `authorization/messages` | 22 |
| `memory/isolation` | 23 |
| `tools/scoping` | 12 |
| **Total** | **138 passing**, 42 `todo` |

The `todo` entries that remain cover agent behaviour and memory lifecycle logic
— the parts that need `lib/` code that does not exist yet.

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
