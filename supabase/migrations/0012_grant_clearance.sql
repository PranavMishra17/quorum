-- 0012 — granting and revoking clearances.
--
-- A gap found by a Phase 2 sanity check, not by a test: `user_clearances` had a
-- SELECT policy and no write path at all. D-003 says grants are administrative,
-- and that was implemented as "nobody can grant anything" — so a user who signed
-- in fresh held no clearance, could neither see nor create a gated chat, and the
-- second authorisation axis was unreachable outside the seed script.
--
-- ---------------------------------------------------------------------------
-- THE RULE: you cannot grant a clearance you do not hold yourself.
--
-- This is the delegation rule real clearance systems use, and it is the only
-- one that keeps the axis meaningful. The alternatives both collapse it:
--
--   - Self-granting makes clearance a checkbox, not an authorisation axis.
--   - An unrestricted grant lets a level-1 user mint level-3 for a confederate
--     and read everything, which is privilege escalation with extra steps.
--
-- Granting AT your own level is permitted rather than strictly below it,
-- because a peer onboarding a peer is the common case and forbidding it would
-- make the highest rung ungrantable by anyone.
--
-- SECURITY DEFINER, because the check reads the CALLER's grants — which a
-- policy on the row being inserted cannot express.

create or replace function public.grant_clearance(
  p_user_id      uuid,
  p_clearance_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := auth.uid();
  v_target_lvl int;
  v_actor_lvl  int;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'unknown user' using errcode = '23503';
  end if;

  select level into v_target_lvl
  from public.clearances where id = p_clearance_id;

  if v_target_lvl is null then
    raise exception 'unknown clearance' using errcode = '23503';
  end if;

  select coalesce(max(c.level), -1) into v_actor_lvl
  from public.user_clearances uc
  join public.clearances c on c.id = uc.clearance_id
  where uc.user_id = v_actor;

  if v_actor_lvl < v_target_lvl then
    raise exception 'cannot grant a clearance above your own'
      using errcode = '42501';
  end if;

  insert into public.user_clearances (user_id, clearance_id, granted_by)
  values (p_user_id, p_clearance_id, v_actor)
  on conflict (user_id, clearance_id) do nothing;
end
$$;

-- ---------------------------------------------------------------------------
-- Revocation is the same rule, plus one addition: you may always revoke your
-- OWN clearance. Giving up access you hold needs no permission from anyone, and
-- being unable to drop a clearance would be a strange thing to enforce.
-- ---------------------------------------------------------------------------

create or replace function public.revoke_clearance(
  p_user_id      uuid,
  p_clearance_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := auth.uid();
  v_target_lvl int;
  v_actor_lvl  int;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select level into v_target_lvl
  from public.clearances where id = p_clearance_id;
  if v_target_lvl is null then
    raise exception 'unknown clearance' using errcode = '23503';
  end if;

  if p_user_id <> v_actor then
    select coalesce(max(c.level), -1) into v_actor_lvl
    from public.user_clearances uc
    join public.clearances c on c.id = uc.clearance_id
    where uc.user_id = v_actor;

    if v_actor_lvl < v_target_lvl then
      raise exception 'cannot revoke a clearance above your own'
        using errcode = '42501';
    end if;
  end if;

  delete from public.user_clearances
  where user_id = p_user_id and clearance_id = p_clearance_id;
end
$$;

revoke all on function public.grant_clearance(uuid, uuid) from public;
revoke all on function public.revoke_clearance(uuid, uuid) from public;
grant execute on function public.grant_clearance(uuid, uuid) to authenticated;
grant execute on function public.revoke_clearance(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Bootstrap: the first user in an empty workspace holds nothing, so under the
-- rule above nobody could ever grant anything and the ladder would be
-- permanently unusable.
--
-- This grants the BASE rung (level 0) to anyone who holds nothing at all. It is
-- safe precisely because level 0 is the floor: `general` gates nothing, since
-- an ungated chat already requires level 0. It removes the deadlock without
-- handing out any access that was not already implied.
-- ---------------------------------------------------------------------------

create or replace function public.claim_base_clearance()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_base  uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if exists (select 1 from public.user_clearances uc where uc.user_id = v_actor) then
    return; -- already holds something; nothing to bootstrap
  end if;

  select id into v_base from public.clearances order by level asc limit 1;
  if v_base is null then
    return; -- ladder not seeded
  end if;

  insert into public.user_clearances (user_id, clearance_id, granted_by)
  values (v_actor, v_base, v_actor)
  on conflict (user_id, clearance_id) do nothing;
end
$$;

revoke all on function public.claim_base_clearance() from public;
grant execute on function public.claim_base_clearance() to authenticated;
