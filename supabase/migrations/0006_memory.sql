-- 0006 — memory. This is thesis 1.
--
-- The assignment says the agent "learns useful information about users and can
-- use it in future conversations". Implemented literally, a fact told in a DM
-- becomes usable in a group with a different audience. This migration is what
-- makes that impossible, in SQL, before any ranking happens.

create type public.memory_source as enum ('stated', 'inferred');
create type public.memory_status as enum ('candidate', 'active', 'superseded', 'stale');

create table public.memory_items (
  id                uuid primary key default gen_random_uuid(),
  -- Who the fact is ABOUT.
  subject_user_id   uuid not null references auth.users(id) on delete cascade,
  -- Where it was learned. Provenance, and the reason the audience snapshot
  -- below can be reconstructed and audited.
  origin_chat_id    uuid not null references public.chats(id) on delete cascade,
  origin_message_id uuid references public.messages(id) on delete set null,
  content           text not null check (length(content) between 1 and 2000),

  -- Lexical ranking. D-004 closed against wiring an embedding provider in v1,
  -- so there is no `embedding` column: ranking is ts_rank over an already
  -- authorised candidate set. A generated column keeps it impossible for the
  -- index and the content to drift apart.
  search_vector     tsvector generated always as (to_tsvector('english', content)) stored,

  -- Axis two, frozen at learn time. The clearance level of the chat this was
  -- learned in — NOT a live lookup, because the origin chat's requirement can
  -- change and that must not retroactively widen what has already been learned.
  clearance_level   int not null check (clearance_level >= 0),

  source_type       public.memory_source not null,
  confidence        real not null check (confidence >= 0 and confidence <= 1),
  status            public.memory_status not null default 'candidate',
  superseded_by     uuid references public.memory_items(id) on delete set null,
  created_at        timestamptz not null default now(),
  -- For time-sensitive facts. NULL means durable.
  expires_at        timestamptz,

  constraint superseded_items_point_somewhere
    check ((status = 'superseded') = (superseded_by is not null))
);

create index memory_items_subject_idx on public.memory_items (subject_user_id, status);
create index memory_items_origin_idx  on public.memory_items (origin_chat_id);
create index memory_items_search_idx  on public.memory_items using gin (search_vector);

-- ---------------------------------------------------------------------------
-- memory_audience — the table the whole thesis rests on.
--
-- A snapshot of exactly who was an ACTIVE MEMBER of the originating chat at the
-- instant the item was learned. Immutable once written.
--
-- Containment is evaluated against this and never against current membership,
-- because membership changes: someone who joined a group in March was not in
-- the room in January, and evaluating against the present would either leak the
-- item to them or spuriously withdraw it everywhere.
-- ---------------------------------------------------------------------------

create table public.memory_audience (
  memory_item_id uuid not null references public.memory_items(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  primary key (memory_item_id, user_id)
);

create index memory_audience_user_idx on public.memory_audience (user_id);

-- ---------------------------------------------------------------------------
-- No client access whatsoever.
--
-- Postgres has no "deny" policy: access is GRANTED by at least one PERMISSIVE
-- policy. So the construction is RLS enabled, NO policy written at all, and the
-- default privileges revoked. With nothing to grant access, no row is visible.
--
-- The revokes are not belt-and-braces. The auth shim (and a real Supabase
-- project) grants table privileges to anon/authenticated by default; without
-- revoking, these tables would be reachable the moment anyone added a policy.
-- ---------------------------------------------------------------------------

alter table public.memory_items    enable row level security;
alter table public.memory_audience enable row level security;

revoke all on public.memory_items    from anon, authenticated;
revoke all on public.memory_audience from anon, authenticated;

-- ---------------------------------------------------------------------------
-- THE SURFACING RULE, in SQL, evaluated before any ranking.
--
--   An item learned in chat C1 may surface in chat C2 only if
--     (a) every active member of C2 was in the item's audience snapshot, AND
--     (b) C2's clearance level >= the item's clearance level.
--
-- Filtering happens here rather than after retrieval because authorisation is
-- not a relevance problem: fetching the top 20 by relevance and discarding the
-- unauthorised 5 is a different program with the same output most of the time,
-- and a leak the rest of the time.
-- ---------------------------------------------------------------------------

create or replace function private.memory_visible_in_chat(p_chat_id uuid)
returns setof public.memory_items
language sql
stable
security definer
set search_path = ''
as $$
  with active_members as (
    select m.user_id
    from public.chat_members m
    where m.chat_id = p_chat_id
      and m.status  = 'member'
  ),
  chat_clearance as (
    select coalesce(
      (select cl.level
       from public.chats c
       join public.clearances cl on cl.id = c.required_clearance_id
       where c.id = p_chat_id),
      0
    ) as level
  )
  select i.*
  from public.memory_items i
  cross join chat_clearance
  where
    -- THE FAIL-CLOSED GUARD. Read this before touching anything below it.
    --
    -- "Every active member of C2 was in the snapshot" is VACUOUSLY TRUE when
    -- C2 has no active members — NOT EXISTS over an empty set. Without this
    -- line, a fully vacated chat matches every memory item in the system: the
    -- exact leak this project exists to prevent, arriving through the front
    -- door of its own central rule.
    (select count(*) from active_members) > 0

    -- Lifecycle: candidates were never accepted, superseded items lost to a
    -- newer fact, stale items timed out. None may surface.
    and i.status = 'active'
    and (i.expires_at is null or i.expires_at > now())

    -- (b) Clearance floor.
    and i.clearance_level <= chat_clearance.level

    -- (a) Audience containment, as an anti-join: there must be no active member
    -- of C2 who is absent from the snapshot. The audience may narrow, never
    -- widen.
    and not exists (
      select 1
      from active_members a
      where not exists (
        select 1
        from public.memory_audience ma
        where ma.memory_item_id = i.id
          and ma.user_id        = a.user_id
      )
    )
$$;

-- Callable only by the server-side scoped path. `authenticated` must never
-- reach it — it would be a complete authorisation oracle for memory.
revoke all on function private.memory_visible_in_chat(uuid) from public;
grant execute on function private.memory_visible_in_chat(uuid) to service_role;
