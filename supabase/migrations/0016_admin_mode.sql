-- 0016 — admin mode: self-granting clearance and self-joining groups, for demos.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE THE SQL
--
-- These functions let a caller grant themselves any clearance and add
-- themselves to any group. That is self-service privilege escalation in a
-- project whose entire thesis is that clearance is enforced, and no amount of
-- naming makes it something else.
--
-- It exists because demonstrating a TWO-AXIS model from one browser otherwise
-- requires three separate Google accounts. A reviewer who cannot see the
-- difference between "member but uncleared" and "cleared but not a member"
-- cannot check the graded claim at all, which is worse than a clearly-fenced
-- tool.
--
-- ---------------------------------------------------------------------------
-- THREE INDEPENDENT GATES, AND WHY IT IS NOT ENOUGH TO GATE IT IN THE APP
--
-- The obvious version of this is an env-var check in a route handler. That is
-- not sufficient on its own: the RPC would still be a permanent escalation
-- function in the production database, callable directly by anyone holding the
-- publishable key — which ships in the browser bundle. The app's UI not showing
-- a button prevents nothing.
--
-- So the gate that actually matters is in here:
--
--   1. `private.admin_mode_secret` must contain a row. The migration creates
--      the table EMPTY. On a project where nobody deliberately inserts one,
--      these functions refuse no matter what any environment variable says, and
--      no matter who calls them. Deploying this migration to production leaves
--      admin mode dead on arrival.
--   2. The caller must present that secret. It lives in server-side env
--      (`ADMIN_MODE_SECRET`) and is passed by a route handler, so a browser
--      holding only the publishable key cannot call these at all.
--   3. `lib/auth/admin-mode.ts` additionally requires NODE_ENV != production
--      and an explicit ALLOW_ADMIN_MODE=true, so the route is not even mounted
--      in a production build.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS STILL NOT
--
-- It is not a read bypass. These functions change WHAT A USER HOLDS; they never
-- change what holding it means. Every read afterwards goes through the same
-- policies as anyone else's, so a self-granted `restricted` user sees exactly
-- what a legitimately-granted one would — which is the point of the demo.
--
-- Every call writes a `public.admin_mode_log` row, from inside the function, so
-- a self-issued clearance can be told apart from a granted one. A reviewer who
-- suspects the demo was rigged can check, and that auditability is what makes
-- this honest rather than merely hidden.

create table private.admin_mode_secret (
  -- A single row, or none. The primary key makes "none or one" a constraint
  -- rather than a convention.
  id     boolean primary key default true check (id),
  secret text    not null check (length(secret) >= 16)
);

-- No grants to anyone. Reached only from the SECURITY DEFINER bodies below.
revoke all on table private.admin_mode_secret from anon, authenticated;

comment on table private.admin_mode_secret is
  'Empty by design. Insert a row ONLY on a development or demo project — doing '
  'so arms the self-grant functions in 0016. Production must leave it empty.';


-- ---------------------------------------------------------------------------
-- The audit trail.
--
-- A separate table rather than `agent_events`, for two reasons that both matter.
-- `agent_events.chat_id` is NOT NULL and granting a clearance has no chat; and
-- that table has no client insert policy at all, by design, because it is the
-- agent's append-only record. Widening it so a user could write to it would
-- damage the thing it is for.
--
-- The rows are written INSIDE the SECURITY DEFINER functions below, not by the
-- route handler. An audit the caller performs as a separate step is an audit
-- the caller can skip — including by accident, which is how the first draft of
-- this went: the handler wrote to a table with no insert policy, the write
-- failed silently, and the feature would have shipped claiming an audit trail
-- that did not exist.

create table public.admin_mode_log (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  action       text        not null check (action in ('grant', 'revoke', 'join', 'leave')),
  target_id    uuid        not null,
  created_at   timestamptz not null default now()
);

create index admin_mode_log_user_idx on public.admin_mode_log (user_id, created_at desc);

alter table public.admin_mode_log enable row level security;

-- You may read your own record of what you gave yourself. Nobody may write it
-- from a client: the functions below do that, so the row cannot be forged or
-- omitted.
create policy admin_mode_log_select_own
  on public.admin_mode_log for select
  to authenticated
  using (user_id = (select auth.uid()));

comment on table public.admin_mode_log is
  'Every self-grant made through admin mode. Written only by the dev_self_* '
  'functions, so a demonstrated authorisation rule can be told apart from a '
  'rigged one.';

-- ---------------------------------------------------------------------------

create or replace function private.admin_mode_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.admin_mode_secret s
    where s.secret = p_secret
  )
$$;

-- ---------------------------------------------------------------------------
-- Self-grant a clearance.
--
-- Takes no user id: the grant lands on `auth.uid()` and can land nowhere else.
-- Even armed, and even with the secret, this cannot be pointed at somebody
-- else's account — the blast radius is the caller and only the caller.

create or replace function public.dev_self_grant(
  p_clearance_id uuid,
  p_secret       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not private.admin_mode_ok(p_secret) then
    -- Deliberately the same message whether the table is empty or the secret is
    -- wrong. Distinguishing them would confirm that admin mode is armed here.
    raise exception 'admin mode is not available' using errcode = '42501';
  end if;

  insert into public.user_clearances (user_id, clearance_id, granted_by)
  values (v_actor, p_clearance_id, v_actor)
  on conflict (user_id, clearance_id) do nothing;

  insert into public.admin_mode_log (user_id, action, target_id)
  values (v_actor, 'grant', p_clearance_id);
end;
$$;

revoke all on function public.dev_self_grant(uuid, text) from public;
grant execute on function public.dev_self_grant(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Self-revoke, so a demo can go BACKWARDS.
--
-- Arguably the more useful half: "watch this room disappear when I drop the
-- clearance" is a better demonstration of the rule than watching one appear.

create or replace function public.dev_self_revoke(
  p_clearance_id uuid,
  p_secret       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not private.admin_mode_ok(p_secret) then
    raise exception 'admin mode is not available' using errcode = '42501';
  end if;

  delete from public.user_clearances
   where user_id = v_actor and clearance_id = p_clearance_id;

  insert into public.admin_mode_log (user_id, action, target_id)
  values (v_actor, 'revoke', p_clearance_id);
end;
$$;

revoke all on function public.dev_self_revoke(uuid, text) from public;
grant execute on function public.dev_self_revoke(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Self-join a group.
--
-- Restricted to `type = 'group'`: joining someone's DM would put a third person
-- in a two-person room, which the DM shape check forbids for good reason and
-- which no demo needs.

create or replace function public.dev_self_join(
  p_chat_id uuid,
  p_secret  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not private.admin_mode_ok(p_secret) then
    raise exception 'admin mode is not available' using errcode = '42501';
  end if;

  if not exists (select 1 from public.chats c where c.id = p_chat_id and c.type = 'group') then
    raise exception 'only groups can be joined this way' using errcode = '22023';
  end if;

  insert into public.chat_members (chat_id, user_id, role, status)
  values (p_chat_id, v_actor, 'member', 'member')
  on conflict (chat_id, user_id) do update
    set status = 'member', removed_at = null;

  insert into public.admin_mode_log (user_id, action, target_id)
  values (v_actor, 'join', p_chat_id);
end;
$$;

revoke all on function public.dev_self_join(uuid, text) from public;
grant execute on function public.dev_self_join(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Self-leave, the mirror of the above.

create or replace function public.dev_self_leave(
  p_chat_id uuid,
  p_secret  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not private.admin_mode_ok(p_secret) then
    raise exception 'admin mode is not available' using errcode = '42501';
  end if;

  update public.chat_members
     set status = 'removed', removed_at = now()
   where chat_id = p_chat_id and user_id = v_actor;

  insert into public.admin_mode_log (user_id, action, target_id)
  values (v_actor, 'leave', p_chat_id);
end;
$$;

revoke all on function public.dev_self_leave(uuid, text) from public;
grant execute on function public.dev_self_leave(uuid, text) to authenticated;
