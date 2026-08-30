-- 0011 — chat creation.
--
-- A chat and its members must be created together. Split across two
-- `supabase-js` calls they are two transactions, and a failure between them
-- leaves an orphaned chat with nobody in it — which, under the memory
-- surfacing rule, is exactly the zero-active-members case the fail-closed
-- guard exists for. Better not to create it at all.
--
-- There is also a bootstrap problem the RLS policies cannot solve on their own:
-- adding another member requires being an admin, and you cannot be an admin of
-- a chat that has no members yet. The policy in 0003 handles the creator
-- seating themselves; this function handles the rest in one transaction.
--
-- SECURITY DEFINER, so it validates everything itself and fails closed.

create or replace function public.create_chat(
  p_type                  public.chat_type,
  p_name                  text,
  p_member_ids            uuid[],
  p_required_clearance_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_members uuid[];
  v_chat    uuid;
  v_id      uuid;
  v_req_level int;
  v_has_level int;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- The creator is always a member. Deduplicated so passing yourself in the
  -- list is harmless rather than a primary-key violation.
  select array_agg(distinct m) into v_members
  from unnest(array_append(coalesce(p_member_ids, '{}'::uuid[]), v_actor)) as m
  where m is not null;

  -- Every named member must actually exist. Without this, a typo'd id creates
  -- a chat whose roster references nobody, and the foreign key would only
  -- catch it after the chat row is already written.
  if exists (
    select 1 from unnest(v_members) as m
    where not exists (select 1 from public.profiles p where p.id = m)
  ) then
    raise exception 'unknown participant' using errcode = '23503';
  end if;

  -- The brief: chats always contain a minimum of two users. The `agent` type is
  -- the documented exception (README assumption 1) — one human, plus the agent.
  if p_type = 'dm' then
    if array_length(v_members, 1) <> 2 then
      raise exception 'a DM has exactly two people' using errcode = '23514';
    end if;
    if p_required_clearance_id is not null then
      raise exception 'a DM cannot be clearance-gated' using errcode = '23514';
    end if;
  elsif p_type = 'group' then
    if array_length(v_members, 1) < 2 then
      raise exception 'a group needs at least two people' using errcode = '23514';
    end if;
    if p_name is null or length(btrim(p_name)) = 0 then
      raise exception 'a group needs a name' using errcode = '23514';
    end if;
  elsif p_type = 'agent' then
    if array_length(v_members, 1) <> 1 then
      raise exception 'an agent chat has exactly one person' using errcode = '23514';
    end if;
  end if;

  -- You may not create a room you could not then enter. Without this you could
  -- gate a chat above your own level and lock yourself out of something you own
  -- — and, worse, create a space whose existence you cannot see.
  if p_required_clearance_id is not null then
    select level into v_req_level
    from public.clearances where id = p_required_clearance_id;

    if v_req_level is null then
      raise exception 'unknown clearance' using errcode = '23503';
    end if;

    select coalesce(max(c.level), -1) into v_has_level
    from public.user_clearances uc
    join public.clearances c on c.id = uc.clearance_id
    where uc.user_id = v_actor;

    if v_has_level < v_req_level then
      raise exception 'cannot create a chat above your own clearance'
        using errcode = '42501';
    end if;
  end if;

  insert into public.chats (type, name, created_by, required_clearance_id)
  values (p_type, nullif(btrim(coalesce(p_name, '')), ''), v_actor, p_required_clearance_id)
  returning id into v_chat;

  -- The creator administers a group. DMs and agent chats have no
  -- administration (D-002), so everyone in them is a plain member.
  foreach v_id in array v_members loop
    insert into public.chat_members (chat_id, user_id, role, status, joined_at)
    values (
      v_chat,
      v_id,
      -- The CASE yields text, and chat_members.role is an enum — Postgres will
      -- not coerce it implicitly here, so the cast is required.
      (case when p_type = 'group' and v_id = v_actor then 'admin' else 'member' end)::public.member_role,
      'member'::public.member_status,
      now()
    );
  end loop;

  return v_chat;
end
$$;

revoke all on function public.create_chat(public.chat_type, text, uuid[], uuid) from public;
grant execute on function public.create_chat(public.chat_type, text, uuid[], uuid) to authenticated;
