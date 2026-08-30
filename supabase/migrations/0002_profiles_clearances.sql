-- 0002 — profiles, clearances, user_clearances.
--
-- RLS is enabled and policied HERE, in the migration that creates each table.
-- Never in a follow-up: the publishable key is in the browser bundle, so a
-- table live for even one deploy without a policy is fully readable.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url   text,
  -- Per-user colour for message attribution in the UI.
  color        text not null default '#7c8cf8',
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Readable by any signed-in user. This is a deliberate product decision, not an
-- oversight: the space view shows every person as a bubble you can click to DM,
-- which is impossible if you cannot see that they exist. Profiles carry no
-- private content — display name, avatar, colour.
create policy profiles_select_authenticated
  on public.profiles for select
  to authenticated
  using (true);

-- You may only create or edit your own profile row.
-- `(select auth.uid())` rather than a bare call: wrapping it makes the planner
-- treat it as an InitPlan evaluated once, not a function call per row.
create policy profiles_insert_own
  on public.profiles for insert
  to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No delete policy: profiles are removed by cascade from auth.users only.

-- ---------------------------------------------------------------------------
-- clearances — the sensitivity ladder (D-023)
--
-- ONE dimension: how sensitive the material is. Nothing here names a team, a
-- department, or who is in the room. Team membership is chat_members' job.
-- ---------------------------------------------------------------------------

create table public.clearances (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  -- The comparison is `held.level >= required.level`, so this must be a total
  -- order. Unique enforces that two rungs cannot share a level.
  level       int  not null unique check (level >= 0),
  description text
);

alter table public.clearances enable row level security;

-- A lookup table of ladder rungs. Readable by any signed-in user; knowing that
-- a "Confidential" level exists discloses nothing.
create policy clearances_select_authenticated
  on public.clearances for select
  to authenticated
  using (true);

-- No insert/update/delete policy for clients. The ladder is seeded by migration
-- and changed by migration.

-- ---------------------------------------------------------------------------
-- user_clearances — who holds what
-- ---------------------------------------------------------------------------

create table public.user_clearances (
  user_id      uuid not null references auth.users(id) on delete cascade,
  clearance_id uuid not null references public.clearances(id) on delete restrict,
  granted_at   timestamptz not null default now(),
  granted_by   uuid references auth.users(id) on delete set null,
  primary key (user_id, clearance_id)
);

create index user_clearances_user_idx on public.user_clearances (user_id);

alter table public.user_clearances enable row level security;

-- Readable by any signed-in user, because the space view renders clearance
-- badges on other people's bubbles. Documented assumption: holding a clearance
-- is public metadata about capability; it is not itself sensitive content.
-- The alternative (self-only) would make the badge feature impossible.
create policy user_clearances_select_authenticated
  on public.user_clearances for select
  to authenticated
  using (true);

-- Deliberately NO client write policy. A user granting themselves a clearance
-- would defeat the entire second authorisation axis. Grants are administrative
-- and happen through the server-side scoped path.
