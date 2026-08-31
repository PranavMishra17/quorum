-- 0020 — the demo world: a bounded, clearly-marked, per-user demonstration set.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR
--
-- A judge or a technical reviewer signing in for the first time otherwise lands
-- on an empty workspace (or, post-0017/0018, a handful of ungated groups with no
-- history) and has to be told what to click to see the thesis work. This closes
-- that gap: on first sign-in, every new account gets exactly two demo rooms that
-- walk the memory-isolation claim end to end, using the REAL agent — no reply in
-- this system is ever scripted, only the ROOM and its one seed message are.
--
-- ---------------------------------------------------------------------------
-- THE DEMO WORLD IS TWO ROOMS, NOT FOUR — AND THAT IS THE DESIGN, NOT A CUT
--
-- An earlier plan had a group with pre-written back-and-forth between two
-- personas ("agent stays quiet in a group") plus a separate contract-review
-- room plus a separate memory-isolation pair — four rooms, most of their content
-- scripted. That is a worse demo, not a richer one: every scripted line is a
-- line a technical reviewer has to mentally discount as "not really the system
-- talking", and a demo whose content the reviewer has to keep sorting into
-- real/fake is the exact confusion this feature exists to prevent.
--
-- So it is two rooms, and their ONLY seeded content is one message each,
-- because that is all it takes to set up a real interaction:
--
--   1. A DM with "Priya" — a natural opening line inviting the user to tell the
--      agent something about their own schedule, plus a real attached PDF
--      (attached by a follow-up step in `lib/demo/seed.ts`, because Storage
--      objects cannot be written from SQL — see that file).
--   2. A group with "Priya" AND "Sam" — no seed message at all. Its entire job
--      is to be a room "Priya" was in and "Sam" was not, so that asking the
--      agent the same question here demonstrates the withholding directly.
--
-- Everything after the seed message is the user's own real conversation with
-- the real agent, through the real pipeline, with real telemetry. There is no
-- mechanism anywhere in this system for scripting a reply on another user's
-- behalf mid-conversation, and there deliberately never will be — see the
-- rejected design below.
--
-- ---------------------------------------------------------------------------
-- THE PERSONAS ARE REAL ACCOUNTS, EXCLUDED FROM EVERY ORDINARY SURFACE
--
-- "Priya" and "Sam" are genuine rows in `auth.users`, created once by
-- `scripts/seed-demo-personas.mjs` — they have to be, because `chat_members`,
-- `messages.sender_id` and every other identity column in this schema is a
-- foreign key to `auth.users(id)`. There is no lighter-weight "fake person"
-- representation available without special-casing every one of those tables.
--
-- What keeps them from being confusing is that `profiles.is_demo` marks them,
-- and every ordinary directory query (the workspace Directory grid, the "New
-- group" people picker, the clearance-granting list on Account) filters it out
-- at the application layer. They exist ONLY inside demo-marked chats.
--
-- ---------------------------------------------------------------------------
-- REJECTED: A GENERIC "POST AS ANOTHER USER" RPC
--
-- The original scope asked for suggested replies where "the other human's
-- reply is a hardcoded row" during ONGOING interaction, gated by "a
-- SECURITY DEFINER RPC restricted to demo chats". Building that — a function
-- callable at any time that inserts a message with an arbitrary sender_id —
-- is a message-forgery primitive with a chat-type check bolted on, and a bug in
-- that check is a bug that lets one user speak as another. The one-time seed
-- message inserted by `ensure_demo_world()` below is a NARROWER thing: it runs
-- once, at world-creation, writes exactly one row, and cannot be invoked again
-- for a room that already has its seed. There is no standing capability to post
-- as someone else — only a single, idempotent, self-limiting act of setup.

alter table public.profiles add column is_demo boolean not null default false;
alter table public.chats    add column is_demo boolean not null default false;

-- Which suggestion chips the composer offers. Set once, at creation, by
-- ensure_demo_world(); read by the client to pick a canned prompt list. NULL
-- for every ordinary chat.
alter table public.chats add column demo_kind text
  check (demo_kind is null or demo_kind in ('contract', 'isolation'));

comment on column public.profiles.is_demo is
  'A demo persona (e.g. the seeded "Priya"/"Sam" accounts), never a real '
  'reviewer. Excluded from the Directory, New group, and clearance-granting '
  'lists at the application layer — see app/(app)/chats/page.tsx.';

comment on column public.chats.is_demo is
  'A per-user demonstration room created by ensure_demo_world(). Rendered with '
  'a DEMO stamp; excluded from the default-group auto-join in '
  'private.join_default_groups() below.';

-- ---------------------------------------------------------------------------
-- 0017's trigger, corrected to exclude demo chats.
--
-- Migrations are append-only, so this is a CREATE OR REPLACE of the same
-- function 0017 defined, not an edit to that file. Without the exclusion, a
-- demo group (type='group', ungated) would be joined by EVERY new signup
-- through the ordinary default-group path — turning a per-user demo room into
-- a shared one, which defeats the entire "Sam was not in the room" premise the
-- isolation demo depends on.

create or replace function private.join_default_groups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.chat_members (chat_id, user_id, role, status)
  select c.id, new.id, 'member', 'member'
    from public.chats c
   where c.type = 'group'
     and c.required_clearance_id is null
     and c.is_demo = false                 -- new: never auto-join a demo room
  on conflict (chat_id, user_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Create the caller's demo world. Idempotent: a user who already has one is a
-- silent no-op, so calling this on every sign-in (see lib/demo/seed.ts) is safe.
--
-- Takes no parameters — the demo world it builds is always the CALLER's own,
-- for the same reason no ScopedAgentContext method takes a scope-defining id.
--
-- Returns the created chat ids (null columns if nothing was created, whether
-- because a world already existed or because the personas are not seeded on
-- this environment) so the Node-side caller knows whether to attach the demo
-- PDF to a freshly-made contract room.

create or replace function public.ensure_demo_world()
returns table (created boolean, contract_chat_id uuid, group_chat_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_priya  uuid;
  v_sam    uuid;
  v_dm     uuid;
  v_group  uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Already has one. Silent no-op — this runs on every sign-in.
  if exists (
    select 1 from public.chat_members m
    join public.chats c on c.id = m.chat_id
    where m.user_id = v_actor and c.is_demo = true
  ) then
    return query select false, null::uuid, null::uuid;
    return;
  end if;

  -- Personas not provisioned on this environment. Skip gracefully rather than
  -- failing sign-in — a missing demo world must never be the reason a real
  -- user cannot get into the product. Run scripts/seed-demo-personas.mjs once
  -- per environment to enable this.
  select id into v_priya from auth.users where email = 'priya.demo@quorum.dev';
  select id into v_sam   from auth.users where email = 'sam.demo@quorum.dev';
  if v_priya is null or v_sam is null then
    raise notice 'demo personas not seeded — skipping demo world for %', v_actor;
    return query select false, null::uuid, null::uuid;
    return;
  end if;

  -- Room 1 — the contract-review DM. Its file is attached by a Node-side step
  -- immediately after this call returns; Storage objects cannot be written
  -- from SQL, only their metadata row can (and that row does not exist yet).
  insert into public.chats (type, name, created_by, is_demo, demo_kind)
  values ('dm', null, v_priya, true, 'contract')
  returning id into v_dm;

  insert into public.chat_members (chat_id, user_id, role, status, joined_at)
  values
    (v_dm, v_actor, 'member', 'member', now()),
    (v_dm, v_priya, 'member', 'member', now());

  insert into public.messages (chat_id, sender_type, sender_id, content, created_at)
  values (
    v_dm, 'user', v_priya,
    'Hey — starting on the Meridian MSA, draft attached below. I''m out Friday, '
    'so if it''d help, tell the assistant when you actually review contracts and '
    'it can work to your schedule instead of mine.',
    now() - interval '2 days'
  );

  -- Room 2 — the isolation counterpart. Deliberately NO seed message: its only
  -- job is to be a room Priya was in and Sam was not, so that asking the same
  -- question here demonstrates withholding rather than describing it.
  insert into public.chats (type, name, created_by, is_demo, demo_kind)
  values ('group', 'Demo: Team Sync', v_priya, true, 'isolation')
  returning id into v_group;

  insert into public.chat_members (chat_id, user_id, role, status, joined_at)
  values
    (v_group, v_actor, 'member', 'member', now()),
    (v_group, v_priya, 'admin',  'member', now()),
    (v_group, v_sam,   'member', 'member', now());

  return query select true, v_dm, v_group;
end;
$$;

revoke all on function public.ensure_demo_world() from public;
grant execute on function public.ensure_demo_world() to authenticated;

-- ---------------------------------------------------------------------------
-- Undo the caller's demo world, so they can watch it get built again.
--
-- Deletes only chats where is_demo = true AND the caller is a member — by
-- construction this can never reach a non-demo chat or another user's demo
-- world, so there is no privilege here beyond "delete my own demo rooms".
-- Cascades (chats -> chat_members/messages/agent_events/llm_calls/memory_items
-- are all `on delete cascade` from migrations 0003-0007) take the rest with it.
--
-- What this does NOT clean up: the Storage object for the demo PDF, which has
-- no SQL-level handle. It is orphaned bytes at a path nobody's `files` row
-- points at any longer — harmless, and stated rather than silently accepted as
-- solved.

create or replace function public.reset_demo_world()
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

  delete from public.chats
   where is_demo = true
     and id in (select chat_id from public.chat_members where user_id = v_actor);
end;
$$;

revoke all on function public.reset_demo_world() from public;
grant execute on function public.reset_demo_world() to authenticated;
