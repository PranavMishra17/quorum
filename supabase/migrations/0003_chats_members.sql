-- 0003 — chats, chat_members, and the two authorisation axes.
--
-- This migration is the core of thesis 2. Everything the project claims about
-- authorisation is either enforced here or is not enforced at all.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create type public.chat_type as enum ('dm', 'group', 'agent');
create type public.member_role as enum ('admin', 'member');
create type public.member_status as enum ('member', 'requested', 'invited', 'removed');

create table public.chats (
  id                    uuid primary key default gen_random_uuid(),
  type                  public.chat_type not null,
  name                  text,
  created_by            uuid not null references auth.users(id) on delete restrict,
  -- Axis two. NULL means the chat is ungated; any member may read it.
  required_clearance_id uuid references public.clearances(id) on delete restrict,
  created_at            timestamptz not null default now(),

  -- A DM is between two people and is never administered or clearance-gated;
  -- gating it would be meaningless when both parties already see everything.
  constraint dm_has_no_clearance
    check (type <> 'dm' or required_clearance_id is null),
  constraint group_has_name
    check (type <> 'group' or name is not null)
);

create table public.chat_members (
  chat_id    uuid not null references public.chats(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.member_role   not null default 'member',
  status     public.member_status not null default 'member',
  joined_at  timestamptz,
  removed_at timestamptz,
  primary key (chat_id, user_id)
);

-- Hot paths: "which chats am I in" and "who is in this chat".
create index chat_members_user_idx on public.chat_members (user_id, status);
create index chat_members_chat_idx on public.chat_members (chat_id, status);

-- ---------------------------------------------------------------------------
-- Authorisation predicates
--
-- These are SECURITY DEFINER for a specific reason, not out of habit: an RLS
-- policy on `chat_members` that queries `chat_members` recurses infinitely.
-- Running the lookup as the definer bypasses the policy on the inner read and
-- breaks the cycle.
--
-- `search_path = ''` is mandatory here. Without it, a caller controlling their
-- own search_path could shadow `public.chat_members` with a table of their own
-- and make the predicate return whatever they like. Every reference below is
-- therefore fully schema-qualified.
--
-- These are NOT granted to anon or authenticated: only the policy engine calls
-- them, so a client cannot use them as an authorisation oracle.
-- ---------------------------------------------------------------------------

create or replace function private.is_chat_member(p_chat uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1
    from public.chat_members m
    where m.chat_id = p_chat
      and m.user_id = p_user
      -- Only 'member' counts. 'requested' and 'invited' are pending rows with
      -- no read rights; 'removed' is a tombstone.
      and m.status  = 'member'
  )
$$;

create or replace function private.is_chat_admin(p_chat uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1
    from public.chat_members m
    where m.chat_id = p_chat
      and m.user_id = p_user
      and m.status  = 'member'
      and m.role    = 'admin'
  )
$$;

create or replace function private.is_chat_creator(p_chat uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.chats c where c.id = p_chat and c.created_by = p_user
  )
$$;

-- Axis two. A monotone ladder: holding a HIGHER level satisfies a LOWER
-- requirement. Returns false for a chat that does not exist — fail closed.
create or replace function private.meets_clearance(p_chat uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and coalesce((
    select
      c.required_clearance_id is null
      or exists (
        select 1
        from public.user_clearances uc
        join public.clearances held on held.id = uc.clearance_id
        join public.clearances req  on req.id  = c.required_clearance_id
        where uc.user_id = p_user
          and held.level >= req.level
      )
    from public.chats c
    where c.id = p_chat
  ), false)
$$;

-- BOTH axes. This is the single predicate every content policy calls; there is
-- deliberately no way to check one axis without the other from a policy.
create or replace function private.can_access_chat(p_chat uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_chat_member(p_chat, p_user)
     and private.meets_clearance(p_chat, p_user)
$$;

-- ---------------------------------------------------------------------------
-- RLS — chats
-- ---------------------------------------------------------------------------

alter table public.chats enable row level security;

-- Two ways to see a chat row, and they grant very different things.
--
--   1. You pass both axes — you are in it and cleared for it.
--   2. It is a GROUP and you meet its clearance floor. Groups must be
--      discoverable for the join-request flow to exist at all: you cannot ask
--      to join something you cannot see.
--
-- Note what discovery is gated on. Membership does NOT gate it — that is the
-- point — but clearance DOES. A chat requiring Restricted is invisible to
-- someone without it, name included, because the existence of a restricted
-- conversation is itself disclosure. This is what makes the README's claim
-- ("a gated group is unreachable without sufficient clearance, regardless of
-- any membership row") true of discovery and not only of content.
--
-- Discovery exposes metadata only. Messages, events, files and memory are all
-- gated on can_access_chat(). DMs and agent chats are never discoverable.
create policy chats_select
  on public.chats for select
  to authenticated
  using (
    (type = 'group' and private.meets_clearance(id, (select auth.uid())))
    or private.can_access_chat(id, (select auth.uid()))
  );

create policy chats_insert_own
  on public.chats for insert
  to authenticated
  with check (created_by = (select auth.uid()));

-- Only admins reconfigure a chat. Note the WITH CHECK as well as the USING:
-- without it, an admin could pass the row check on the way in and rewrite
-- `created_by` or drop the clearance requirement on the way out.
create policy chats_update_admin
  on public.chats for update
  to authenticated
  using (private.is_chat_admin(id, (select auth.uid())))
  with check (private.is_chat_admin(id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- RLS — chat_members
-- ---------------------------------------------------------------------------

alter table public.chat_members enable row level security;

-- You can see your own membership row whatever its status — otherwise a pending
-- join request would be invisible to the person who made it. Seeing that row
-- grants nothing: every content policy requires status = 'member'.
--
-- Otherwise you see the roster only for chats you can actually access.
create policy chat_members_select
  on public.chat_members for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or private.can_access_chat(chat_id, (select auth.uid()))
  );

-- Three legitimate inserts, and nothing else:
--   1. An admin adds someone.
--   2. You ask to join, as yourself, with status 'requested' and no admin role.
--   3. The chat's creator seats themselves — the bootstrap case, because a new
--      chat has no admin yet and rule 1 would deadlock on it.
create policy chat_members_insert
  on public.chat_members for insert
  to authenticated
  with check (
    private.is_chat_admin(chat_id, (select auth.uid()))
    or (
      user_id = (select auth.uid())
      and status = 'requested'
      and role   = 'member'
    )
    or (
      user_id = (select auth.uid())
      and private.is_chat_creator(chat_id, (select auth.uid()))
    )
  );

-- Admins manage the roster. You may also update your OWN row, which exists so
-- that leaving a chat is possible; the WITH CHECK confines a self-update to
-- status 'removed', so this cannot be used to self-promote to admin or to
-- upgrade a 'requested' row into membership.
create policy chat_members_update
  on public.chat_members for update
  to authenticated
  using (
    private.is_chat_admin(chat_id, (select auth.uid()))
    or user_id = (select auth.uid())
  )
  with check (
    private.is_chat_admin(chat_id, (select auth.uid()))
    or (user_id = (select auth.uid()) and status = 'removed')
  );

-- No DELETE policy. Membership is ended by setting status to 'removed', which
-- keeps the history of who was present — and the audience snapshots that were
-- taken while they were.
