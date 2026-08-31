-- 0023 — showcase rooms were joinable by every new signup, and marking them
-- `is_demo` to fix that would have let a visitor's own reset delete them.
--
-- ---------------------------------------------------------------------------
-- THE BUG, FOUND BY LOOKING AT A REAL SCREENSHOT
--
-- `private.join_default_groups()` (0017, corrected in 0020, corrected again in
-- 0022) joins every new profile to every ungated, non-demo group. "Litigation
-- Support" (`scripts/seed-showcase-accounts.mjs`) is exactly that shape —
-- ungated, and not marked `is_demo` — so every real signup this session
-- silently landed in it. Nine members on a group meant to hold three.
--
-- The obvious fix is `is_demo = true`. The reason it wasn't set already:
-- `reset_demo_world()` deletes every `is_demo = true` chat the CALLER is a
-- member of — so Jordan or Morgan clicking "Reset demo" on their own account
-- page would delete their entire showcase world, which is supposed to be a
-- fixed, standing thing, not something a visitor can accidentally wipe.
--
-- The actual fix is narrower than either: `reset_demo_world()` should only
-- ever touch the PER-VISITOR demo rooms (`ensure_demo_world()`'s contract and
-- isolation rooms), which are the only ones with a non-null `demo_kind`. The
-- showcase rooms have `demo_kind = null` by construction (`scripts/
-- seed-showcase-accounts.mjs` never sets it). So: mark the showcase rooms
-- `is_demo = true` — closing the auto-join leak — and narrow the delete to
-- `demo_kind is not null` — keeping them immune to reset regardless.

update public.chats
   set is_demo = true
 where name in ('Meridian Deal Team', 'Litigation Support')
   and demo_kind is null;

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
     and demo_kind is not null          -- new: never the standing showcase rooms
     and id in (select chat_id from public.chat_members where user_id = v_actor);
end;
$$;

revoke all on function public.reset_demo_world() from public;
grant execute on function public.reset_demo_world() to authenticated;

-- One-time cleanup: remove memberships the auto-join leak already produced —
-- a real (non-demo, non-showcase) user sitting in a showcase room they never
-- asked to join. Scoped to exactly the two showcase rooms by name, and to
-- members who are not themselves seeded identities, so a showcase account's
-- own legitimate membership is untouched.
delete from public.chat_members cm
using public.chats c, public.profiles member
where cm.chat_id = c.id
  and cm.user_id = member.id
  and c.name in ('Meridian Deal Team', 'Litigation Support')
  and member.is_demo = false
  and member.is_showcase = false;
