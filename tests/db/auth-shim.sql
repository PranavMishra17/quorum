-- Local-only Supabase `auth` shim. NOT a migration, never applied to a real project.
--
-- Supabase provides an `auth` schema, an `auth.users` table, `auth.uid()`, and the
-- `anon` / `authenticated` / `service_role` roles. A bare Postgres does not. This
-- file recreates just enough of that surface that the REAL migrations run
-- unmodified against a local instance — which is the point: if the policies were
-- rewritten for the test environment, the tests would be testing something other
-- than what ships.
--
-- `auth.uid()` reads `request.jwt.claims`, exactly as Supabase's does, so the
-- test harness sets authorisation context the same way PostgREST does.

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's implementation: the subject claim of the request JWT.
-- The nullif() must wrap the SETTING, before the jsonb cast. An unset GUC reads
-- as the empty string, and ''::jsonb raises rather than returning NULL — so
-- casting first makes every signed-out query error instead of resolving to NULL,
-- which turns "denied" into "crashed" throughout the anon paths.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub',
    ''
  )::uuid
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

-- The three roles PostgREST switches into.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    -- BYPASSRLS is exactly what makes this role dangerous, and exactly why
    -- tests must never use it to verify a policy.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Default privileges — the detail that decides whether these tests mean anything
--
-- In a real Supabase project, `anon` and `authenticated` DO hold table-level
-- GRANTs on everything in `public`; row-level security is what narrows them.
-- Reproducing that here matters more than it looks: without these grants, a
-- policy test would pass because the role lacked the privilege, not because the
-- policy denied the row. Every authorisation test would be green, and none of
-- them would be testing RLS.
--
-- Tables that must be unreachable from any client (the memory tables) revoke
-- these explicitly in their own migration, and rely on having no policy at all.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
