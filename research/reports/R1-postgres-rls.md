# R1 — Postgres row-level security, deeply

**Band:** A · **Closes:** correctness of every migration (no single D-0xx; this
report is the reference the migrations in `supabase/migrations/` are written
against) · **Status:** complete

## Question

RLS is named in the README as the layer that "survives a bug in the
application code" and the reason the publishable Supabase key is safe to ship
in the browser bundle. `docs/ARCHITECTURE.md` §4 commits to a specific shape —
a `SECURITY DEFINER` membership/clearance predicate function, one policy per
table written in the same migration that creates it, and a two-axis model
(membership AND clearance) — before a single migration exists. "RLS prevents
unauthorised rows" is not enough understanding to defend that shape against
questioning; this report works out the exact SQL, the exact recursion fix, and
the exact test harness so the migrations in `0002`–`0007` can be written
correctly the first time, since CLAUDE.md non-negotiable #1 and D-018 both
forbid a follow-up migration to add a policy.

## Findings

**1. `USING` vs `WITH CHECK`, and the omission failure mode.**
Per the command-applicability table in the Postgres docs, `SELECT` and
`DELETE` policies only ever use `USING`; `INSERT` only ever uses `WITH CHECK`;
`UPDATE` (and `ALL`) can use both. The load-bearing rule, quoted directly from
the docs: "if no `WITH CHECK` expression is defined, then the `USING`
expression will be used both to determine which rows are visible... and which
new rows will be allowed to be added" (PostgreSQL, *CREATE POLICY*,
https://www.postgresql.org/docs/current/sql-createpolicy.html). So omitting
`WITH CHECK` on an `UPDATE` policy is not silently permissive — Postgres backs
it with `USING`. The actual failure mode is the opposite direction and more
subtle: `USING` is evaluated against the **pre-update** row and `WITH CHECK`
against the **post-update** row. A policy that writes only `USING (chat_id =
...)` and relies on the fallback cannot stop a member from *updating a row's
`chat_id` to point it into a chat they don't belong to* if the two chats
otherwise satisfy the same `USING` predicate — because the fallback re-uses
the same predicate for the post-image, but if that predicate does not
constrain the columns being changed, both images can pass. The safe pattern
for any row Quorum lets a user mutate (there are few — most tables are
insert/read only from the client) is to write `WITH CHECK` explicitly and make
it re-assert immutable ownership columns, not just copy `USING`.

**2. Policy composition — `PERMISSIVE` OR, `RESTRICTIVE` AND, and what this
schema wants.**
"All permissive policies which are applicable to a given query will be
combined together using the Boolean 'OR' operator. All restrictive policies...
[with] AND. ... a record is only accessible if at least one of the permissive
policies passes, in addition to all the restrictive policies. ... there needs
to be at least one permissive policy to grant access... If only restrictive
policies exist, then no records will be accessible" (PostgreSQL, *CREATE
POLICY*, same URL as above; confirmed independently via web search of the same
doc page and the `ddl-rowsecurity` page). Policies default to `PERMISSIVE`
unless `AS RESTRICTIVE` is stated.

For Quorum's two-axis model this settles sub-question 2 concretely: **one
combined predicate per policy, not one `PERMISSIVE` policy per axis.** Two
separate `PERMISSIVE` policies — one for membership, one for clearance — would
be OR'd together, which means satisfying *either* axis grants access. That is
exactly the leak D-003 exists to prevent (a level-3 and level-0 chat sharing a
member set). The two axes must appear inside a single `USING`/`WITH CHECK`
expression joined by SQL `AND`, e.g. `USING (is_chat_member(chat_id) AND
has_required_clearance(chat_id))`, evaluated as one `PERMISSIVE` policy. The
alternative that also works is one `PERMISSIVE` policy for membership plus a
second policy declared `AS RESTRICTIVE` for clearance — `RESTRICTIVE`
policies AND against the permissive result, so this also enforces "both must
pass." Either shape is correct; a single combined-predicate policy is simpler
to audit (one `pg_policies` row per table per command, matching CLAUDE.md's
"one filter path, one place to audit" instinct) and is the one this report
recommends.

**3. `SECURITY DEFINER` in policies: why, the `search_path` hardening, and
per-row cost.**
`SECURITY DEFINER` functions run with the privileges of the function's
*owner*, not the caller — that is what lets a membership-check function read
`chat_members` while the caller's own row-visibility into `chat_members` is
still being decided (see finding 4). Supabase's own guidance is explicit and
should be treated as load-bearing: "Set `search_path = ''` on every `security
definer` function and schema-qualify the names inside it... Without a pinned
`search_path`, a caller can point an unqualified name at their own object and
run it with the function owner's privileges" (Supabase, *Row Level Security*,
https://supabase.com/docs/guides/database/postgres/row-level-security). This
is the same class of vulnerability as an unqualified `PATH` in a setuid shell
script, and Postgres's own security advisories treat it the same way — an
attacker-created object in a schema earlier in the caller's `search_path` gets
executed with the function owner's authority. Supabase's second, related
warning also matters here: never expose a `SECURITY DEFINER` helper in a
schema that PostgREST serves through the API — it becomes directly callable
by any client with the owner's privileges, defeating RLS entirely rather than
supporting it.

On per-row cost: the docs' own performance guidance is about a *different* but
related cost — calling `auth.uid()` (or a `SECURITY DEFINER` function) as a
bare function call inside a policy causes Postgres to invoke it once per
candidate row, not once per statement, because `stable`/`volatile` functions
are not automatically hoisted out of the per-row qual evaluation the way a
constant is. Wrapping the call as `(select auth.uid())` forces an `initPlan`,
so "Postgres... can 'cache' the results per-statement, rather than calling the
function on each row" (Supabase, same URL). I could not find a documented
absolute cost figure (e.g. microseconds per call) in primary sources — the
docs describe the *mechanism* (per-row invocation vs. per-statement caching)
but not a benchmark number. **Flagging as uncertain:** the actual magnitude at
Quorum's scale (a few dozen candidate rows after the audience/clearance filter
already runs) is very likely negligible either way; what is certain is the
`(select ...)` wrapping pattern, and that is what should go in every policy
regardless of measured impact, because it is free to write and only matters
more as tables grow.

**4. Policy recursion — the standard resolution, and whether it reopens a
hole.**
A policy on `chat_members` that itself queries `chat_members` (e.g. "you may
read this membership row if you have a `member` row in the same chat")
recurses: Postgres raises `42P17`, "infinite recursion detected in policy for
relation...". This is a well-documented, repeatedly-hit footgun in exactly
Quorum's shape — a self-referential membership table — confirmed across
multiple independent Supabase GitHub Discussions threads (supabase/supabase
discussions #47525, #1138, #3328; https://github.com/orgs/supabase/discussions/47525
et al.) as well as a Postgres-list precedent for the same class of problem in
security-barrier views
(https://www.postgresql.org/message-id/CAEZATCVJPnUrLjsS626Pp%2Br_bdq-3ofRHWmV0fKx1OgpyLt5ww%40mail.gmail.com).

The standard resolution is exactly what `docs/ARCHITECTURE.md` already
commits to: wrap the membership/clearance check in a `SECURITY DEFINER`
function owned by a role that is **not** subject to the `chat_members` RLS
policy in the same call path (in practice: a role that has `BYPASSRLS`, or —
more precisely for Supabase — a function that runs as `postgres`/the schema
owner, whose reads of `chat_members` inside the function body are not
re-evaluated through the calling user's RLS policy, because `SECURITY
DEFINER` changes the effective role for privilege *and* RLS-policy-owner
purposes for the duration of the function). This "isolates the admin/member
check in one place, reusable across all tables" (dev.to, *Supabase RLS
SECURITY DEFINER: Preventing Infinite Recursion*,
https://dev.to/kanta13jp1/supabase-rls-security-definer-preventing-infinite-recursion-in-admin-policies-4go2
— a secondary source, used here only for the phrasing of a pattern that the
GitHub Discussions threads and the Postgres docs already establish as
correct, not as sole authority).

**Does this reopen a privilege hole?** Only if the function is written
carelessly. The function itself must still filter by the *specific caller* —
i.e. it must take `auth.uid()` (or the caller id) as an implicit or explicit
input and constrain its own query to that caller's rows (`where user_id =
(select auth.uid())`), even though it is running with elevated read access
internally. If it instead returns membership rows for *all* users because "it
runs as `postgres` now," that is the hole: a function that bypasses RLS
internally but does not re-apply the caller-specific filter turns into an
unscoped read. The function must combine "unrestricted read access to break
the recursion" with "explicit re-application of the caller filter" — dropping
either half is wrong. This is exactly the shape of `is_chat_member(chat_id
uuid)` needed in `0003_chats_members.sql`.

**5. How the identity reaches Postgres, and what is true inside `SECURITY
DEFINER`.**
PostgREST (which sits behind every Supabase API/RLS-enforced read) decodes the
caller's JWT and sets it as Postgres session-level GUC (config) variables —
`request.jwt.claim.sub`, `request.jwt.claim.role`, and the full JSON as
`request.jwt.claims` — before running the statement, and switches the active
Postgres role to `anon` or `authenticated` (or a custom role) based on the
JWT's `role` claim (Supabase, *Row Level Security*, same URL; confirmed via a
second, independent fetch of the same page and cross-checked against the
public `auth.uid()` function body reported consistently across multiple
supabase/supabase GitHub issues, e.g. #43066, #4244:
`select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
(current_setting('request.jwt.claims', true)::jsonb ->> 'sub')), '')::uuid`).
`auth.uid()` returns `NULL` for an unauthenticated request, which matters
because `null = user_id` is never true in SQL — Supabase's own guidance
explicitly recommends writing `auth.uid() IS NOT NULL AND auth.uid() =
user_id` rather than relying on the equality alone.

**Inside a `SECURITY DEFINER` function, the caller's identity is still
visible**, because `SET LOCAL`/session GUCs (including `request.jwt.claims`)
are a property of the *session/transaction*, not of the *role* — `SECURITY
DEFINER` changes which role's table privileges and RLS-bypass-eligibility
apply for the duration of the call, but it does not reset or hide session
GUCs. This is why `is_chat_member(chat_id)` can call `auth.uid()` internally
and get the real caller, even while reading `chat_members` with elevated
privilege. I did not find a single official doc page stating this in one
sentence — it is inferred correctly from (a) the documented semantics of
`SECURITY DEFINER` in the Postgres manual (which changes role for privilege
checking only) and (b) the documented behaviour of GUCs as session-scoped —
but I am flagging that the specific sentence "GUCs survive a `SECURITY
DEFINER` role switch" was not found verbatim in a primary Supabase or Postgres
source during this pass, only load-bearing corroborating facts. **What would
fully settle it:** a one-line local test — set `request.jwt.claim.sub`,
`SET ROLE authenticated`, call a `SECURITY DEFINER` function that returns
`auth.uid()`, confirm the value round-trips — is trivial and should be the
first assertion in `tests/authorization/rls.test.ts` before anything else,
precisely because the entire membership-predicate design depends on it being
true.

**6. Service-role bypass — role attribute, not a distinct claim, and it does
not skip `GRANT`s.**
The mechanism is the Postgres role attribute `BYPASSRLS`, not a special JWT
claim that Postgres interprets differently: "A secret key authorizes access
through the `service_role` Postgres role, which has the `bypassrls`
attribute" (Supabase, *Row Level Security*, same URL). The JWT's `role` claim
is what tells PostgREST to `SET ROLE service_role`; the *reason* that role
then sees everything is the ordinary Postgres rule that `BYPASSRLS`-attributed
roles skip RLS policy evaluation entirely (documented generally at
PostgreSQL's `ALTER ROLE`/RLS chapter, and specifically for Supabase's role
architecture at https://supabase.com/docs/guides/database/postgres/roles and
https://supabase.com/docs/guides/database/postgres/roles-superuser). A subtlety
worth stating precisely for the README, since D-018/CLAUDE.md rule #2 lean on
it: **a client initialized with the secret key does not automatically bypass
RLS if the request itself carries a *user* access token** — in that case
PostgREST runs the request under that user's `authenticated` role and their
policies apply, "even when the client library was initialized with a secret
key" (Supabase, same URL). This matters for `lib/db/scoped-agent.ts`: the
module must construct its Postgres/PostgREST client from the secret key
*alone*, never forwarding an end-user's session/access token alongside it, or
the intended full-bypass behaviour silently reverts to that user's own RLS
scope (which would be a functional bug, not a leak — but a confusing one to
debug, since the failure would look like RLS working when the code intended
`BYPASSRLS`).

`BYPASSRLS` and Postgres `GRANT`s are two independent mechanisms and the
former does not imply the latter: bypassing RLS only skips *row-visibility
policy evaluation* — the role still needs ordinary object-level privileges
(`SELECT`/`INSERT`/`UPDATE`/`DELETE` grants on the table, `USAGE` on the
schema) to touch a table at all. In Supabase's stock setup `service_role` is
provisioned with broad schema grants during project bootstrap specifically so
that `BYPASSRLS` is sufficient in practice — but this is a *provisioning*
fact, not a property of `BYPASSRLS` itself, and it is worth stating that
distinction precisely rather than conflating "bypasses RLS" with "has global
access," since a custom schema created later needs its own `GRANT`s to
`service_role` regardless of `BYPASSRLS`.

**7. Performance — RLS predicates and index usage on `messages(chat_id,
created_at desc)`.**
Two distinct effects, and it's worth keeping them separate because they have
different fixes:

- *Ordinary equality/range predicates on indexed columns are not disabled by
  RLS.* A `chat_id = ...`-shaped predicate combined via the plan with an index
  on `(chat_id, created_at desc)` behaves as an ordinary indexable qual,
  provided the operator involved (`=`, here) is `LEAKPROOF` — which core
  comparison operators are, by default, in Postgres. Supabase's own
  performance guidance treats this as the default-good case and its advice is
  purely about *helping* the planner further: index every column a policy
  filters on, and specify `TO authenticated`/`TO anon` explicitly on the
  policy so "the policy [stops evaluating] for any users who don't match"
  (Supabase, same URL).
- *Non-leakproof operators genuinely do lose planner statistics access.* A
  Postgres mailing-list thread (Tom Lane, replying to a report of GIST/GIN
  indexes being skipped under RLS) states the actual mechanism directly:
  "without access to the table statistics, the [pattern-match] condition is
  estimated to be too unselective to make an indexscan profitable... RLS
  put[s] in the way [and] disable[s] that access if the [operator] is not
  marked leakproof, which it isn't"
  (https://www.postgresql.org/message-id/12552.1565723566%40sss.pgh.pa.us).
  This is specifically about operators like `LIKE`/pattern-match (`~~`) that
  are not leakproof, not about equality predicates generally, and it affects
  planner *cost estimation* (whether the optimiser believes an index scan is
  worthwhile), not a hard prohibition on the index existing or being usable.

**Applied to Quorum's actual hot path:** `messages(chat_id, created_at desc)`
is filtered by `chat_id = $1` (equality, leakproof) inside `ORDER BY
created_at desc LIMIT n` queries — the predicate shape that is least affected
by the leakproof concern. The load-bearing performance risk in this schema is
instead the one flagged in finding 3: whether the membership/clearance
`SECURITY DEFINER` predicate itself gets **evaluated once per statement or
once per row**. Wrapping it as `(select is_chat_member(chat_id))` in every
policy is the concrete, cheap mitigation; `EXPLAIN ANALYZE` against a seeded
table is the way to confirm this holds for real once the migration exists —
this report did not run that against a live Quorum database and that
confirmation is listed as an open follow-up, not asserted as done.

**8. Testing RLS independently of the application.**
Two documented, primary-source-backed patterns, both usable, and Quorum should
use both for different purposes:

- **`pgTAP`, inside the database, using `SET LOCAL`.** Set `role` and the JWT
  GUC directly in a transaction, then assert with `pgTAP`'s `results_eq()` /
  custom assertions: `set local role authenticated; set local
  request.jwt.claim.sub = '<uuid>';` before the query under test (pattern
  documented in Supabase's local-development testing guide and demonstrated
  end-to-end, including multi-user visibility assertions, in a widely-used
  community gist —
  https://gist.github.com/mansueli/ede3563e5dec3e3d4beb88dcaaf66879 — built on
  three helper procedures, `auth.login_as_user(email)`, `auth.login_as_anon()`,
  `auth.logout()`, which wrap the same `SET`/`current_setting` mechanics).
  `SET LOCAL` scopes the role/claim change to the current transaction, which
  is what makes per-test isolation via `BEGIN`/`ROLLBACK` work.
- **Application-level tests against a real local Postgres (`supabase start`),
  driving a Postgres client as the `authenticated` role with the JWT claim set
  per test, then asserting on rows returned/rejected.** This is the shape
  `docs/ARCHITECTURE.md` already specifies for `tests/authorization/rls.test.ts`
  ("runs against a real Postgres as an *unprivileged* role... Testing RLS
  through a service-role client tests nothing"), and it is corroborated by
  Supabase's own testing documentation, which states plainly that tests should
  run "against the same schema, Row Level Security policies, and API
  endpoints that your production app uses" via a local `supabase start` stack
  (Supabase, *Testing Overview*,
  https://supabase.com/docs/guides/local-development/testing/overview).

Both patterns share the identical underlying primitive — set `role` and
`request.jwt.claim.sub`, then run the query as that identity — pgTAP does it
in raw SQL inside a transaction; a vitest-driven `pg` client does it by
opening a connection as `authenticated`/`anon` and issuing the equivalent
`SET`/`SET LOCAL` statements (or, more simply for Supabase specifically,
using `supabase-js` initialized with a real signed JWT for a seeded test
user, which is the closest simulation of the production request path since it
also exercises PostgREST's claim-to-GUC translation rather than
hand-simulating it). **The one thing that tests nothing, confirmed by two
independent sources**: running any of this through the `service_role`/secret
key. `BYPASSRLS` means the policy under test is never evaluated at all, so a
green test proves nothing about the policy.

**9. Storage bucket policies.**
Same mechanism, not a separate one: object-level access control is enforced
by RLS policies on the real Postgres table `storage.objects` (owned by the
`storage` schema Supabase provisions), with predicates written against
ordinary columns — `bucket_id`, `name` (the object path/key), and an owner
column — plus storage-specific helper functions such as
`storage.foldername(name)` to decompose a path for folder-scoped rules
(Supabase, *Storage Access Control*,
https://supabase.com/docs/guides/storage/security/access-control). A
representative policy shape from the docs:

```sql
create policy "Allow authenticated uploads"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'my_bucket_id' and
  (storage.foldername(name))[1] = 'private'
);
```

The one behavioural difference worth noting for `0007_files.sql`: Supabase
Storage defaults to **deny** on a bucket with no policies at all (no implicit
"table exists, RLS on, zero policies ⇒ zero rows" ambiguity to worry about —
that is also true of ordinary table RLS, but the docs call it out explicitly
for Storage because uploads, not just reads, are gated the same way). Because
it is the same RLS engine, everything in findings 1–8 (including the
recursion risk if a storage policy queries `chat_members`, and the
`(select ...)` wrapping advice) applies unchanged to `storage.objects`
policies.

## Application to Quorum

Concrete shapes for `supabase/migrations/0003_chats_members.sql` (membership +
clearance predicate) and the two tables it protects, following
`docs/ARCHITECTURE.md` §4 and the two-axis rule in `docs/DECISIONS.md` D-003:

```sql
-- 0003_chats_members.sql (excerpt)

create schema if not exists private;  -- never exposed to PostgREST

create or replace function private.is_active_member(p_chat_id uuid)
returns boolean
language sql
security definer
set search_path = ''               -- finding 3: pinned, empty search_path
stable
as $$
  select exists (
    select 1
    from public.chat_members cm
    where cm.chat_id = p_chat_id
      and cm.user_id = (select auth.uid())   -- finding 5: caller re-applied
      and cm.status = 'member'
  );
$$;

create or replace function private.meets_clearance(p_chat_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (select c.required_clearance_id is null
       or exists (
         select 1
         from public.user_clearances uc
         join public.clearances req on req.id = c.required_clearance_id
         join public.clearances have on have.id = uc.clearance_id
         where c.id = p_chat_id
           and uc.user_id = (select auth.uid())
           and have.level >= req.level
       )
     from public.chats c
     where c.id = p_chat_id),
    false        -- finding on fail-closed: no chat row / no match => false
  );
$$;

revoke all on function private.is_active_member(uuid) from public, anon, authenticated;
revoke all on function private.meets_clearance(uuid) from public, anon, authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
grant execute on function private.meets_clearance(uuid) to authenticated;

alter table public.chat_members enable row level security;

-- ONE combined-predicate PERMISSIVE policy per command (finding 2)
create policy chat_members_select on public.chat_members
  for select to authenticated
  using ( (select private.is_active_member(chat_id)) );   -- finding 3: (select ...)

create policy messages_select on public.messages
  for select to authenticated
  using (
    (select private.is_active_member(chat_id))
    and (select private.meets_clearance(chat_id))
  );
```

This is the specific pattern that resolves the recursion in finding 4:
`private.is_active_member` is `SECURITY DEFINER`, owned by a role not gated by
`chat_members`'s own policy, and its internal query re-applies `auth.uid()` so
it still only ever answers "is *this caller* an active member," not "list all
members." Every table's RLS policy — including `chat_members` itself — can
then call it without the `42P17` recursion the naive self-referential policy
would hit.

Files this bears on directly:

- **`supabase/migrations/0002_profiles_clearances.sql`,
  `0003_chats_members.sql`, `0004_messages.sql`, `0005_agent_events.sql`,
  `0006_memory.sql`, `0007_files.sql`** — each needs exactly this
  combined-predicate, `(select private.fn(...))`-wrapped shape, per D-018 and
  CLAUDE.md rule #1. `0006_memory.sql` is the one exception: per README
  ("Memory tables are stricter still: no client access at all") and
  CLAUDE.md rule #3, `memory_items`/`memory_audience` should carry **no
  `PERMISSIVE` policy granting `authenticated` anything** — RLS enabled, zero
  grants to `authenticated`/`anon`, so the table is unreachable from any
  client key regardless of clearance/membership, and only
  `lib/db/scoped-agent.ts` (via `BYPASSRLS`) can read it.
- **`lib/db/scoped-agent.ts`** — per finding 6, must be constructed from
  `SUPABASE_SECRET_KEY` with no user access token forwarded on the same
  client, or `BYPASSRLS` silently does not apply. This is the concrete
  implementation detail behind CLAUDE.md non-negotiable #2 ("the service-role
  key is read in exactly one file") — the risk finding 6 adds is not just
  "don't read the key elsewhere," but "don't accidentally neuter the key's
  bypass by mixing it with a session token."
- **`tests/authorization/rls.test.ts`** (currently only referenced in
  `docs/ARCHITECTURE.md`, not yet created; `tests/authorization/membership.test.ts`
  and `clearance.test.ts` currently hold the `it.todo()` specs this file will
  implement) — should be built on the `SET LOCAL role` + `request.jwt.claim.sub`
  pattern from finding 8, against a real local Postgres (`supabase start`),
  never through a service-role client. The very first assertion in that file
  should be the round-trip check from finding 5 (`auth.uid()` survives a
  `SECURITY DEFINER` call), since the entire predicate design depends on it.
- **`supabase/migrations/0008_seed_clearances.sql`** — should seed
  `config/agent.ts`'s `CLEARANCES` ladder (`general`/`internal`/
  `external_audit`/`internal_exec`, levels 0–3) as literal rows, matching
  CLAUDE.md rule #8 (no magic numbers outside `config/`) — the migration reads
  the same four rows a reviewer can see in `config/agent.ts`, not a
  re-derivation.
- **`supabase/migrations/0007_files.sql`** — storage bucket policies on
  `storage.objects` per finding 9, predicated on `bucket_id` plus a
  `chat_id`-bearing path segment (via `storage.foldername(name)`) run through
  the *same* `private.is_active_member`/`private.meets_clearance` functions —
  this reuses the recursion fix rather than re-deriving a parallel one, and is
  the concrete answer to sub-question 9 ("same mechanism, not a separate
  one").

## Recommendation

This report does not close a numbered `D-0xx` decision on its own — R1's
deliverable per `research/RESEARCH.md` is a policy cookbook, and the closest
thing to a decision here is **the exact policy shape for the two-axis model**,
which D-003 states as a principle ("both must pass") but does not commit to a
SQL shape.

**Option chosen: one combined-predicate `PERMISSIVE` policy per table per
command** (membership AND clearance inside a single `USING`/`WITH CHECK`
expression, both calls wrapped `(select ...)`, both routed through
`SECURITY DEFINER` functions with `search_path = ''`), over the alternative of
one `PERMISSIVE` membership policy plus one `RESTRICTIVE` clearance policy.

**The strongest argument against this choice, stated fairly:** splitting the
two axes into two separate policy objects (one `PERMISSIVE`, one
`RESTRICTIVE`) is *more* legible in `pg_policies` output and in a migration
diff — a reviewer or an interviewer can see "membership policy" and
"clearance policy" as two named, independently-toggleable objects, which maps
more directly onto D-003's stated claim that these are "two independent axes."
A single combined predicate hides that independence inside one function body,
and if a future requirement needs to relax *just* the clearance axis for one
table (e.g., a table where clearance genuinely should not gate access), a
combined predicate requires editing the function or writing a table-specific
variant, whereas dropping a `RESTRICTIVE` policy is a one-line, self-evidently
scoped change. Given CLAUDE.md's own extensibility charter values "cost to
add" per seam, the two-policy split may compose better in the long run than
this report's recommendation does.

**Why the combined predicate wins anyway for Quorum specifically:** CLAUDE.md
non-negotiable #3 and #4 ("one filter path... one place to audit," "filter
before rank, always") set a bar of auditability that a single `pg_policies`
row per table/command meets more directly than two — with one row, "does this
table enforce both axes" is answered by reading one `USING` expression; with
two, it requires confirming both a `PERMISSIVE` and a `RESTRICTIVE` policy
exist for the same command and neither was dropped in a later migration
(silently regressing to membership-only, which is precisely the level-3/
level-0 leak D-003 exists to prevent). Given that this project is graded
partly on demonstrating the leak is closed rather than merely asserted, the
version that is *harder to accidentally weaken in a future migration* is the
better default.

**If the evidence does not settle it:** it doesn't, entirely — this is a
legitimate engineering-taste call between "fewer moving parts, one predicate"
and "two independently-inspectable policy objects matching the stated mental
model," and the primary sources establish that both are mechanically correct
(finding 2). What would further settle it is not more documentation but a
concrete future requirement: if D-003's two axes are ever expected to be
independently toggled per-table (e.g., a table that should be membership-gated
but explicitly clearance-exempt), the `RESTRICTIVE`-policy split becomes
clearly superior and this recommendation should be revisited then, not before.

## Sources

- PostgreSQL, *CREATE POLICY* — command applicability table, `USING`/`WITH
  CHECK` fallback rule, `PERMISSIVE`/`RESTRICTIVE` combination rule.
  https://www.postgresql.org/docs/current/sql-createpolicy.html
- PostgreSQL, *5.9. Row Security Policies* (`ddl-rowsecurity`) — general RLS
  semantics, cross-checked against the above.
  https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Supabase, *Row Level Security* — `SECURITY DEFINER`/`search_path`
  hardening, `auth.uid()`/`auth.jwt()` semantics, `anon`/`authenticated`
  roles, performance guidance (`(select ...)` wrapping, indexing, `TO`
  clause), service-role/`BYPASSRLS` behaviour including the
  user-access-token-overrides-secret-key subtlety.
  https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase, *Postgres Roles* and *Roles, superuser access and unsupported
  operations* — role architecture, what `service_role` can and cannot do
  beyond RLS bypass. https://supabase.com/docs/guides/database/postgres/roles
  and https://supabase.com/docs/guides/database/postgres/roles-superuser
- supabase/supabase GitHub Discussions #47525, #1138, #3328 — repeated,
  independent reports of `42P17` recursion on self-referential membership
  tables, confirming this is a known, common footgun rather than a
  theoretical concern. https://github.com/orgs/supabase/discussions/47525 ,
  https://github.com/orgs/supabase/discussions/1138 ,
  https://github.com/orgs/supabase/discussions/3328
- dev.to, *Supabase RLS SECURITY DEFINER: Preventing Infinite Recursion in
  Admin Policies* — secondary source, used only for confirming the shape of
  the standard fix already established by the primary sources above, not as
  sole authority.
  https://dev.to/kanta13jp1/supabase-rls-security-definer-preventing-infinite-recursion-in-admin-policies-4go2
- supabase/supabase GitHub Issues #43066 and #4244 — the public `auth.uid()`
  function body (`current_setting('request.jwt.claim.sub', true)` with a
  `request.jwt.claims` JSON fallback), and a documented failure mode when
  claims are not passed through correctly.
  https://github.com/supabase/supabase/issues/43066 and
  https://github.com/supabase/supabase/issues/4244
- PostgreSQL mailing list (Tom Lane), *Re: GIST/GIN index not used with Row
  Level Security* — the `LEAKPROOF`/planner-statistics mechanism behind RLS's
  interaction with index usage, and that it is operator-specific
  (pattern-match operators), not a blanket effect on all indexes.
  https://www.postgresql.org/message-id/12552.1565723566%40sss.pgh.pa.us
- Supabase, *Testing Overview* (local development) — running tests against a
  real local Postgres via `supabase start`, same schema/RLS/API as
  production. https://supabase.com/docs/guides/local-development/testing/overview
- Community gist (mansueli), *Testing Row Level Security (RLS) policies
  @Supabase* — worked example of `auth.login_as_user()`/`auth.login_as_anon()`/
  `auth.logout()` helper procedures wrapping `SET`/`request.jwt.claim.*`, and
  a full multi-user `results_eq()` assertion. Secondary source; the underlying
  `SET LOCAL role` / `request.jwt.claim.sub` mechanism it wraps is confirmed
  by the two primary sources above.
  https://gist.github.com/mansueli/ede3563e5dec3e3d4beb88dcaaf66879
- Supabase, *Storage Access Control* — `storage.objects` as an ordinary
  RLS-protected table, `bucket_id`/`name`/owner columns, `storage.foldername()`
  helper, deny-by-default with no policies.
  https://supabase.com/docs/guides/storage/security/access-control
