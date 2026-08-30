# R12 — Testing strategy

**Band:** B · **Closes:** no single D-0xx (see Recommendation) · **Status:** complete

## Question

Quorum's central claim — that the surfacing rule structurally prevents a
memory leak — is only as credible as the tests that exercise it. `tests/`
already contains five suites written entirely as `it.todo` stubs, deliberately
authored from the README's stated rule before `lib/memory/retrieve.ts` exists
(see `tests/memory/isolation.test.ts` lines 1–20). The open question is not
whether to test, but how to test two specific things honestly: (1) RLS policies
enforced by Postgres itself, which cannot be exercised through a service-role
client because that client is defined (per `docs/ARCHITECTURE.md` §1 and
`lib/db/scoped-agent.ts`) to bypass RLS entirely; and (2) the non-deterministic
gate judge and extraction, which call a live, short-lived, rate-limited
Anthropic key that the suite must not depend on. Getting the harness wrong
would make `tests/authorization/membership.test.ts` and
`tests/memory/isolation.test.ts` — the tests the README calls "the ones that
prove the thesis" — assert nothing.

## Findings

**1. Testing RLS honestly.** There are two credible, non-fake approaches, and
they are not mutually exclusive:

- **pgTAP against the Supabase local stack** (`supabase test db`, files under
  `supabase/tests/<table>_rls.test.sql`). Each test case runs inside a
  transaction and sets `set local role authenticated;` plus
  `set local request.jwt.claim.sub = '<uuid>';` before the assertion, so the
  same policy is evaluated as different, unprivileged identities within one
  test file, then rolled back. This is Supabase's own documented pattern
  [Supabase Testing Overview]. It is SQL-native, requires no application code,
  and is closest to testing the policy as Postgres actually evaluates it.
- **testcontainers-node `PostgreSqlContainer`** driving a real Postgres from
  the vitest suite itself (`@testcontainers/postgresql`), with an unprivileged
  `pg` client authenticated via a JWT claim set per connection/session, mirroring
  the `authenticated` role Supabase's PostgREST layer would use
  [testcontainers-node PostgreSQL module docs]. This runs from `pnpm test`
  without the Supabase CLI or Docker Compose wrapper, and integrates into CI
  the same way `tests/config.test.ts` already does (plain vitest, no external
  service).

Both share the one non-negotiable: **the role under test must be `authenticated`
with a JWT claim, never the service role**, because the service-role key (used
only in `lib/db/scoped-agent.ts` per rule #2 of the repo's non-negotiables)
bypasses RLS by design — asserting against it proves nothing about the policy.
`tests/authorization/membership.test.ts`'s own header comment states this
correctly already.

Trade-off: pgTAP tests live in SQL and describe policies in the same language
they're written in, but they cannot easily assert on TypeScript-level behavior
(e.g., what `lib/memory/retrieve.ts` does with a filtered result). testcontainers
tests live in the same vitest run as everything else and can exercise the full
`lib/db/server.ts` client path, but both approaches require Docker wherever
they run. This repo does not yet specify a CI configuration, so this report
cannot settle which approach runs in CI without knowing whether GitHub Actions
(or wherever `pnpm check` eventually runs) has Docker available — see
Application to Quorum for what to check before deciding.

**2. Fixture design.** The isolation cases in `tests/memory/isolation.test.ts`
need, minimally: 2–3 users, a DM and a group with overlapping but non-identical
membership, one membership change after item creation (join-after-learn), two
clearance levels, and one memory item per audience/clearance combination under
test. A flat SQL fixture (seed file or a `beforeEach` factory function) that
builds this graph once and is referenced by short aliases (`alice`, `bob`,
`dmAB`, `groupABC`, `itemFromDM`) keeps each `it()` body to the assertion, not
the setup — Supabase's own seeding docs recommend exactly this "seed after
migrations, insertions only" split [Supabase Seeding docs]. Concretely this
argues for a `tests/fixtures/graph.ts` builder (not yet in the repo) invoked by
each suite, rather than 200 lines of inline `insert` calls per test file, which
is the trap the sub-question names directly.

**3. Testing non-deterministic components.** `tests/agent/gate.test.ts`'s own
header already states the correct split: the deterministic chain (rules 1–6)
is a pure function of `(message, chatState)` — no DB, no model — and is
unit-tested directly with plain inputs/outputs. The judge is stubbed at the
`lib/llm/provider.ts` boundary (config/architecture already names this as the
one-file swap seam) with fixed transcripts mapped to expected verdicts —
i.e., a small table of `{transcript, expectedVerdict}` fixtures, not a live
call. This is standard "seam" testing (dependency injected at the provider
interface, not the HTTP client) and needs no external research citation beyond
the repo's own architecture doc, which already names `lib/llm/provider.ts` as
the swap point (`docs/ARCHITECTURE.md`). A genuinely separate concern —
whether the *quality* of judge verdicts against real model output is
acceptable — is an eval question, not a unit-test question, and is out of
scope for this track; `docs/ARCHITECTURE.md` doesn't currently name an eval
harness, which is a gap worth flagging but not one R12 can close.

**4. What needs zero API key.** Everything in finding 3's "deterministic
chain" bucket, all of `tests/config.test.ts` (already passing, per its own
comment — pure config validation), the RLS/membership/clearance suites (pure
Postgres, no model call), the fixture graph itself, and the property in
finding 6 below. The *only* code path that needs a key is a live judge call or
a live extraction call — and per finding 3, neither belongs in the unit suite.
This means `pnpm test` as currently scripted (`package.json`: `"test": "vitest
run"`) can run key-free end to end; a key is only needed for a separate,
explicitly-marked eval/smoke pass, which should not be part of `pnpm check`'s
default gate.

**5. Attacking the five isolation tests — is the list sufficient?**
Reading `tests/memory/isolation.test.ts` closely, the file currently has more
than five (three `describe` blocks: audience containment [6 cases], clearance
floor [3 cases], scoped agent context [at least 1 visible before truncation]).
Treating "five" as the sub-question's shorthand for the isolation-specific
cases, here is what the list as written covers and what it plausibly misses:

  - Covered: strict subset audience, overlapping-but-not-contained audience,
    late-joiner exclusion, late-joiner non-effect on others, snapshot-vs-current
    membership, clearance mismatch with identical audience, clearance
    surfacing upward, axis independence.
  - **Gap A — removal, not just joining.** Every "audience" case in the file
    is about someone joining *after* learn time. There is no case for a member
    who was present at learn time (so is correctly in the snapshot) and is
    later *removed* from C2 (not C1) — does an item stay retrievable in C2 for
    the removed user's context, and does it stop being retrievable in C1?
    `docs/ARCHITECTURE.md` §"D-012 Removed members lose history" states access
    ends "at the moment of removal" for the *chat itself*; whether a removal
    from the *origin* chat C1 (after learning, before C2 query) should also
    retroactively narrow the snapshot is not stated by the surfacing rule as
    written ("the audience may narrow, never widen" — README) and is not
    tested anywhere in the current file. This is a real gap: the rule text
    implies narrowing should be *possible* but the mechanism (does removal
    from C1 shrink `memory_audience`, or is the snapshot frozen forever?) is
    unspecified in both the README and the test list.
  - **Gap B — three-or-more-chat transitivity.** All cases are two-chat
    (C1→C2). There's no case for an item learned in C1, correctly withheld
    from C2 (overlap-only), but the same item being incorrectly retrievable
    from a third chat C3 that is a strict subset of C1's audience *and* also
    happens to satisfy clearance — this is implicitly covered by treating each
    pairwise check independently, but no test asserts the rule composes
    correctly across more than one non-origin chat evaluated in the same
    retrieval call (e.g., a 3-chat scoped agent context).
  - **Gap C — empty/degenerate audience.** No case for a chat that, at query
    time, has been fully vacated (all members removed) — does retrieval error,
    return empty, or (worst case) treat "no active members to fail containment
    against" as vacuous truth and leak the item? This is exactly the kind of
    fail-open bug a "fails closed" design (README) should have a test for and
    currently does not.
  - **Gap D — clearance downgrade.** The clearance suite has "surfaces upward"
    and "does not surface downward with identical audience," but no case for
    a user whose *personal* clearance grant is revoked between learn time and
    query time — clearance floor as written is a property of the *chat*
    (`chats.required_clearance_id`), not the user, so this may be a
    non-issue, but the distinction is worth stating explicitly rather than
    assumed, since `user_clearances` exists as its own table.

  This is a genuine finding, not a formality: the list is good on the axis it
  was designed to prove (containment vs. overlap, snapshot vs. current) but
  under-covers the *lifecycle* interaction between the two axes and prior
  chats.

**6. Property-based testing for "visibility never widens."** fast-check
(`fc.assert(fc.property(...))`) is the standard JS/TS property-testing library
and integrates with vitest without a dedicated plugin [fast-check docs]. The
invariant is expressible as: generate a random audience snapshot (a `Set` of
user ids) and a random sequence of membership deltas (join/leave events)
against a candidate chat's *current* member set; the property is
`isVisible(currentMembers, snapshot) === currentMembers.every(u => snapshot.has(u))`,
and additionally, over a random sequence of add/remove operations applied to
`currentMembers`, the boolean result of containment must be **monotonic
non-increasing** as adds occur and can only become `true` again after a
`remove` — i.e., there is no operation sequence for which containment flips
from `false` to `true` without a preceding `remove`. This is a real,
checkable invariant and a good target for `fc.assert`, run over generated
`Set<string>` pairs and generated operation sequences (`fc.array` of tagged
`{op:'add'|'remove', user}` values), with `fc.assert` doing shrinking to a
minimal counterexample automatically on failure. This would live in
`tests/memory/isolation.test.ts` or a new `tests/memory/containment.property.test.ts`
next to the fixed-case tests, not replacing them — property tests catch the
shape of the invariant; the fixed cases in finding 5 catch the specific
scenarios a reviewer would ask about by name.

**7. Time in tests.** Vitest ships `vi.useFakeTimers()` (backed by
`@sinonjs/fake-timers`), which can install a fixed epoch, control `Date`, and
be advanced deterministically with `vi.advanceTimersByTime` /
`vi.setSystemTime` [Vitest fake timers docs]. For `expires_at` (memory
lifecycle), cooldown (gate rule 6), and any "N seconds since last agent
message" check, tests should call `vi.useFakeTimers({ now: <fixed> })` in
`beforeEach` and `vi.useRealTimers()` in `afterEach`, then advance the clock
explicitly rather than using real `setTimeout`/sleep in the test body — this
keeps `expires_at` and cooldown-window tests fast and non-flaky. Where the
check is a plain comparison against `now()` read from the DB layer (RLS/SQL
side, e.g., `expires_at < now()`), fake timers in the JS process do not affect
Postgres's own `now()`; those cases need either a literal past/future
timestamp inserted directly (no timer mocking needed — comparing a fixed
inserted `expires_at` to `NOW()` in SQL is deterministic without any clock
control) or, for pgTAP-side tests, explicit timestamps rather than a `NOW()`-
relative fixture.

## Application to Quorum

- **New file: `tests/fixtures/graph.ts`** — a builder producing the user /
  chat / membership / clearance / memory-item graph described in finding 2,
  parameterized so each suite can request the sub-graph it needs. This directly
  answers sub-question 2 and removes the "200 lines of setup per test" risk
  named there.
- **`tests/authorization/membership.test.ts` and the future
  `tests/authorization/rls.test.ts`** (named in `docs/ARCHITECTURE.md` §"tests/"
  as a fourth authorization file not yet in the repo's current file list) should
  run against a **real Postgres as the `authenticated` role**, per finding 1.
  Given the repo already depends on Supabase (not a generic Postgres image) and
  RLS policies reference Supabase-specific `auth.uid()`/JWT claim conventions
  (per `docs/ARCHITECTURE.md` §"security definer function" note), the
  Supabase-CLI-plus-pgTAP path (`supabase/tests/*_rls.test.sql`, run via
  `supabase test db`) is the lower-risk default because it exercises the exact
  policy syntax Supabase evaluates, without reimplementing Supabase's
  JWT-to-role wiring inside a bare testcontainers Postgres. testcontainers-node
  remains the fallback if `supabase test db` proves too slow or CI lacks the
  Supabase CLI — this is not fully settled here (see Recommendation).
- **`config/agent.ts`** already holds the gate cooldown window and memory
  expiry thresholds per the non-negotiables ("no magic numbers outside
  `config/`"); `tests/agent/gate.test.ts`'s cooldown cases and
  `tests/memory/lifecycle.test.ts`'s `expires_at` cases should import those
  constants rather than hardcoding a duration, so a future threshold change in
  `config/agent.ts` doesn't silently desync the test from the value it's
  supposed to prove.
- **`package.json`** — no key-gated test currently exists or should exist in
  `pnpm test` (finding 4). If an eval/smoke suite requiring a live key is
  added later (per the judge-quality gap noted in finding 3), it should be a
  separate script (e.g. `test:eval`), not part of `test` or `check`.
- **Gap A–C from finding 5** should be added as new `it.todo` entries in
  `tests/memory/isolation.test.ts` before tier 2 implementation begins,
  specifically: a removal-from-origin-chat case, a three-chat composition
  case, and an empty-audience/fail-closed case. This is the concrete,
  actionable output of "attack the test list."
- **New file (recommended): `tests/memory/containment.property.test.ts`**
  implementing the fast-check monotonicity property from finding 6, using
  `fast-check` (would need adding to `devDependencies` — not currently in
  `package.json`).

## Recommendation

R12 does not map cleanly onto one existing open `D-0xx` decision — it is a
harness/methodology track rather than a design-choice track, and none of
D-001 through D-018 in `docs/DECISIONS.md` names "how RLS gets tested" as an
open item. The closest is the wave-2 framing in `research/RESEARCH.md`
("close D-011" is attributed to the R7–R13 batch collectively, but D-011 is
specifically agent-turn idempotency, R8's territory, not R12's). The concrete
decision this report *does* settle is: **use Supabase CLI + pgTAP as the
primary mechanism for RLS-policy tests (`supabase/tests/*_rls.test.sql`, run
via `supabase test db`), with `authenticated`-role, JWT-claim-scoped test
cases**, and use plain vitest (no container, no key) for the deterministic
gate chain, config validation, and the property-based containment invariant.

**The strongest argument against this**, stated fairly: pgTAP tests are SQL,
in a different language and toolchain from the rest of the suite, run by a
different command (`supabase test db` vs `pnpm test`), and do not appear in
the same coverage report or CI summary as everything else — a reviewer running
`pnpm test` and seeing green has *not* actually run the RLS tests unless they
know to run a second command. A testcontainers-node-only approach avoids this
by keeping every test in one vitest run with one command, at the cost of
reimplementing some of what Supabase's local stack (PostgREST + GoTrue JWT
issuance) does for you around `authenticated`-role sessions, and needing
Docker in CI either way.

**What would settle it:** confirming whether the CI environment `pnpm check`
runs in (not yet configured — no `.github/workflows` found in this repo as of
this report) has Docker available and whether `supabase test db` can be
wired into that same `pnpm check` script as a composed step (e.g.
`"test": "vitest run && supabase test db"`) so a single command still runs
everything, which would close the gap the "argument against" raises without
abandoning pgTAP's fidelity advantage.

## Sources

- Supabase, "Testing Overview" — https://supabase.com/docs/guides/local-development/testing/overview
- Supabase, "Advanced pgTAP Testing" — https://supabase.com/docs/guides/local-development/testing/pgtap-extended
- Supabase, "Row Level Security" — https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase, "Seeding your database" — https://supabase.com/docs/guides/local-development/seeding-your-database
- Testcontainers for Node.js, "PostgreSQL module" — https://node.testcontainers.org/modules/postgresql/
- fast-check, "Getting Started" — https://fast-check.dev/docs/introduction/getting-started/
- Vitest, "fakeTimers config" — https://vitest.dev/config/faketimers
- Vitest, "Mocking Dates" — https://vitest.dev/guide/mocking/dates
