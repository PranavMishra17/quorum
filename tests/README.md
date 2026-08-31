# Tests

> The brief asks for *"tests you consider important"*, not for coverage. So the
> organising principle here is: **every test defends a sentence the README
> asserts.** A test that does not defend a claim is probably not one of the
> important ones.

## Layout

Organised by claim, not by source file.

```
config.test.ts, config-env.test.ts   tier/model invariants, env schema
authorization/
  rls-foundation      auth.uid() actually survives a SECURITY DEFINER role switch (T5)
  membership          axis one: chat_members.status = 'member'
  clearance           axis two: clearance level, plus group administration
  clearance-grants    grant_clearance() — never above the granter's own level
  create-chat         atomic chat + first-member insert
  messages            send_message_and_start_turn(), idempotency
  connector-tokens    RLS on, zero policies — reachable only via SECURITY DEFINER
  demo-world          ensure_demo_world()/reset_demo_world(), the default-join exclusion
memory/
  isolation           THE TESTS THAT PROVE THE THESIS
  lifecycle           candidate / active / superseded / stale
  conflict            stated beats inferred; newer beats older
  ranking             ts_rank + recency + speaker presence, over the already-filtered set
  mine, my-memory     the subject-access read — deliberately ignores the surfacing rule
  rpc                 memory_for_chat()/write_memory_item() as the only entry points
agent/
  gate                when the agent speaks and when it does not
  judge               the LLM step's contract, not its taste
  research            the bounded multi-step tool loop
  scoped-context-invariant   no ScopedAgentContext method takes a scope-defining id
  output-sanitisation, llm-errors
tools/
  scoping             a tool inherits the chat's authorisation boundary
  document, session, url-safety, safe-name
connectors/
  crypto, registration
auth/
  dev-login-gate      closed by NODE_ENV, independent of the app flag
files/
  extract-text
ui/
  catalogue, event-trace, markdown
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

**628 assertions passing, 17 `todo`, across 34 files** — run `pnpm test` for
the live count rather than trust a number in a doc that can drift from it.

The remaining `todo` entries are not placeholders in the pejorative sense.
They are test list entries committed as executable intent before the code
they defend existed, so the claims and the suite could never silently drift
apart during the build.

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

## Scenarios — driving the real pipeline with your own data

Everything above proves a rule against the database or a stubbed model — on
purpose (see "Two rules" below), so none of it needs an API key and none of
it costs anything to run in CI. It also means none of it shows you the actual
agent deciding something.

`pnpm scenario <file>` does that instead. Point it at a JSON file describing
users, chats, and a sequence of messages, and it seeds exactly that, sends
each message through the same `send_message_and_start_turn()` RPC the app
uses, and calls `runTurn()` — the same function the message route calls —
directly. Real gate, real memory retrieval, real Claude call. Two examples
ship in [`scenarios/`](../scenarios/):

```bash
pnpm scenario scenarios/memory-isolation.json   # a fact from a private chat, withheld once a second person is present
pnpm scenario scenarios/clearance-floor.json    # identical membership, different clearance — still doesn't cross
```

Each prints a line per event as it happens (gate verdict, memory items
surfaced vs. withheld and why, cost) and the agent's actual reply, so you
judge the outcome yourself rather than reading a pass/fail. This is a sandbox
for exploring behaviour, not a CI gate: it spends real API budget, creates
real (if disposable) accounts, and refuses to run with `NODE_ENV=production`.
The scenario file shape is documented in the script's own header —
[`scripts/run-scenario.ts`](../scripts/run-scenario.ts).

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
