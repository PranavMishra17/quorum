-- 0022 — exclude demo/showcase personas from the default-group auto-join,
-- and clean up the ones already caught by it.
--
-- ---------------------------------------------------------------------------
-- THE GAP
--
-- `private.join_default_groups()` (0017, corrected in 0020) fires on every
-- `public.profiles` insert and adds the new row to every ungated, non-demo
-- group — a real convenience for real signups. It excludes demo CHATS as
-- join *targets* (0020), but never excluded a demo/showcase profile as the
-- new *member*. So creating "Jordan Reyes" (`is_demo = true`) via
-- `scripts/seed-showcase-accounts.mjs` silently added him — and, on this
-- environment, Priya, Sam, Morgan and Casey before him — to every real
-- ungated group a real user had already made ("Watercooler", "All Hands",
-- and so on), which is exactly the "excluded from every ordinary surface"
-- claim migration 0020 makes about these accounts turning out to be false in
-- one specific place: an existing group's own roster.
--
-- Found by querying `chat_members` for the three showcase accounts right
-- after creating them and seeing six unexpected rows, not by reading the
-- trigger and spotting the gap in advance.

create or replace function private.join_default_groups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_demo then
    return new;
  end if;

  insert into public.chat_members (chat_id, user_id, role, status)
  select c.id, new.id, 'member', 'member'
    from public.chats c
   where c.type = 'group'
     and c.required_clearance_id is null
     and c.is_demo = false
  on conflict (chat_id, user_id) do nothing;

  return new;
end;
$$;

-- One-time cleanup: remove exactly the memberships the gap produced — a
-- demo/showcase profile sitting in an ordinary group a real (non-demo) user
-- created. Scoped tightly so it cannot touch a showcase account's OWN rooms
-- (created by that same demo/showcase profile, so the join predicate below is
-- false for them) or anyone real.
delete from public.chat_members cm
using public.chats c, public.profiles member, public.profiles creator
where cm.chat_id = c.id
  and cm.user_id = member.id
  and c.created_by = creator.id
  and member.is_demo = true
  and c.is_demo = false
  and creator.is_demo = false;
