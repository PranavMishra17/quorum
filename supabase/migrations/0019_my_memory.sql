-- 0019 — let a person read what the agent has recorded ABOUT THEM.
--
-- ---------------------------------------------------------------------------
-- THE ONE READ PATH INTO MEMORY THAT IS NOT THE AGENT'S
--
-- `memory_items` and `memory_audience` have RLS on and no policy at all, so no
-- client can read a row, ever. That is deliberate and it stays: a browser able
-- to query memory would be able to enumerate what the agent knows about
-- everyone, which is the leak the project exists to prevent.
--
-- But there is a person for whom "what does this thing know about me" is not an
-- attack, and that is the subject of the fact. A system that quietly builds a
-- profile of someone and gives them no way to look at it is the failure mode
-- every memory product is criticised for, and it would be strange for THIS
-- project — whose whole argument is about who may see what — to be the one that
-- ships it.
--
-- So: exactly one function, returning only rows where
-- `subject_user_id = auth.uid()`. Not a policy on the table, because a policy
-- widens the table for every query that touches it; a function widens one
-- question with one answer.
--
-- ---------------------------------------------------------------------------
-- IT RETURNS THE SCOPE, NOT JUST THE FACT
--
-- The interesting column is not `content`, it is WHERE the item can surface.
-- A fact you can see but cannot place is not transparency — "Quorum knows you
-- review contracts on Fridays" is much less useful than "…learned in your DM
-- with Carol, and it can only ever appear where Carol is also present".
--
-- So the function also returns the audience size and the origin chat, and the
-- caller resolves names through the ordinary policies. It does NOT return the
-- audience's user ids: who else was in a room is those people's business, and
-- the count answers the question without naming them.
--
-- What it deliberately does not do is let you EDIT or DELETE. Memory is
-- append-only and supersession is the agent's mechanism (D-014); a user-facing
-- delete would need its own decision about what happens to items derived from
-- a deleted one, and inventing that here would be worse than not offering it.
-- Stated as a limitation rather than half-built.

create or replace function public.my_memory()
returns table (
  id              uuid,
  content         text,
  source_type     public.memory_source,
  status          public.memory_status,
  confidence      real,
  clearance_level int,
  origin_chat_id  uuid,
  audience_size   int,
  created_at      timestamptz,
  expires_at      timestamptz,
  superseded_by   uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id,
    i.content,
    i.source_type,
    i.status,
    i.confidence,
    i.clearance_level,
    i.origin_chat_id,
    (select count(*)::int from public.memory_audience a where a.memory_item_id = i.id),
    i.created_at,
    i.expires_at,
    i.superseded_by
  from public.memory_items i
  where i.subject_user_id = (select auth.uid())
  order by i.created_at desc
$$;

-- Takes no user id, so it cannot be pointed at somebody else. `auth.uid()` is
-- re-applied inside the body, which is what keeps a SECURITY DEFINER function
-- from becoming an unscoped read (T4).
revoke all on function public.my_memory() from public;
grant execute on function public.my_memory() to authenticated;
