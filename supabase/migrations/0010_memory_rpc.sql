-- 0010 — the memory retrieval RPC.
--
-- `private.memory_visible_in_chat()` from 0006 is the authorisation filter, and
-- `private` is not exposed over PostgREST — correctly, because a client able to
-- call it would have a complete oracle for memory. But `lib/memory/retrieve.ts`
-- reaches the database over PostgREST like everything else, so it needs a
-- public entry point.
--
-- This wrapper adds exactly one thing to the filter: the lexical relevance
-- score. Ranking itself stays in TypeScript, because the rank step combines
-- relevance with recency and speaker presence and is expected to change; the
-- FILTER is what must never move out of SQL.
--
-- That split is the point of "filter before rank". The authorised set is
-- established here, in the database, and TypeScript only ever sees rows that
-- already passed. Retrieving by relevance and discarding the unauthorised
-- afterwards would be a different program with the same output most of the
-- time, and a leak the rest of the time.

create or replace function public.memory_for_chat(
  p_chat_id uuid,
  p_query   text
)
returns table (
  id                uuid,
  subject_user_id   uuid,
  origin_chat_id    uuid,
  content           text,
  clearance_level   int,
  source_type       public.memory_source,
  confidence        real,
  created_at        timestamptz,
  relevance         real
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    m.id,
    m.subject_user_id,
    m.origin_chat_id,
    m.content,
    m.clearance_level,
    m.source_type,
    m.confidence,
    m.created_at,
    -- websearch_to_tsquery tolerates arbitrary user text: it never raises on
    -- punctuation or operators, which plainto_tsquery and to_tsquery do. The
    -- query string comes from a chat message, so it is arbitrary by definition.
    coalesce(
      ts_rank(m.search_vector, websearch_to_tsquery('english', p_query)),
      0
    )::real as relevance
  from private.memory_visible_in_chat(p_chat_id) m
$$;

-- Server-side scoped path only. `authenticated` must never reach this.
revoke all on function public.memory_for_chat(uuid, text) from public;
grant execute on function public.memory_for_chat(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Writing a memory item and its audience snapshot must be ATOMIC.
--
-- If the item lands and the snapshot does not, the item has an EMPTY audience.
-- Under the surfacing rule an empty snapshot means it surfaces nowhere, so the
-- failure is safe — but it is also invisible, and an item that can never be
-- retrieved is silent data loss. Worse, a partial write in the other order is
-- not expressible at all, since the snapshot references the item.
--
-- One function, one transaction, snapshot taken from live membership at the
-- instant of the write — which is exactly what "audience is a learn-time
-- snapshot" means (D-006).
-- ---------------------------------------------------------------------------

create or replace function public.write_memory_item(
  p_subject_user_id   uuid,
  p_origin_chat_id    uuid,
  p_origin_message_id uuid,
  p_content           text,
  p_clearance_level   int,
  p_source_type       public.memory_source,
  p_confidence        real,
  p_status            public.memory_status,
  p_expires_at        timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_audience_size int;
begin
  insert into public.memory_items (
    subject_user_id, origin_chat_id, origin_message_id, content,
    clearance_level, source_type, confidence, status, expires_at
  ) values (
    p_subject_user_id, p_origin_chat_id, p_origin_message_id, p_content,
    p_clearance_level, p_source_type, p_confidence, p_status, p_expires_at
  )
  returning id into v_id;

  -- The snapshot: who was ACTIVELY in the room at this instant. Immutable
  -- afterwards — a member leaving later does not shrink it, because they did
  -- hear the thing.
  insert into public.memory_audience (memory_item_id, user_id)
  select v_id, cm.user_id
  from public.chat_members cm
  where cm.chat_id = p_origin_chat_id
    and cm.status  = 'member';

  get diagnostics v_audience_size = row_count;

  -- A chat with no active members cannot teach the agent anything, and an item
  -- with an empty snapshot is unretrievable by construction. Refusing is
  -- clearer than storing a row that can never surface.
  if v_audience_size = 0 then
    raise exception 'cannot learn from a chat with no active members'
      using errcode = '23514';
  end if;

  return v_id;
end
$$;

revoke all on function public.write_memory_item(
  uuid, uuid, uuid, text, int, public.memory_source, real, public.memory_status, timestamptz
) from public;

grant execute on function public.write_memory_item(
  uuid, uuid, uuid, text, int, public.memory_source, real, public.memory_status, timestamptz
) to service_role;
