-- 0017 — every new user lands in the ungated groups.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- A fresh sign-in previously landed on an empty workspace: no chats, no groups,
-- nothing to click. That is an honest rendering of the authorisation model and
-- a terrible first thirty seconds — the reviewer's first impression of a
-- product about who-can-see-what is a screen showing nothing, with no way to
-- tell "correctly empty" from "broken".
--
-- So a new profile joins every group that requires NO clearance, as an ordinary
-- member. That is real product behaviour, not a demo trick: an all-hands channel
-- everyone is in is how workspaces actually work.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not touch gated groups. `required_clearance_id is null` is the whole
-- filter, so a group with any clearance floor still needs a grant and still
-- needs someone to add you. Auto-joining those would quietly hand every new
-- account both authorisation axes at once and make the entire model decorative.
--
-- It does not backfill existing users. A trigger on insert answers "what should
-- happen to somebody new"; retroactively adding today's users to groups they
-- never joined would rewrite membership history, and `memory_audience` snapshots
-- are taken against membership at learn time — so a backfill would silently
-- change who counts as having been in the room. Existing accounts join by hand.
--
-- ---------------------------------------------------------------------------
-- WHY IT HANGS OFF profiles, NOT auth.users
--
-- `ensureProfile()` runs on first sign-in, so a profile row is the earliest
-- point at which the user is a participant this schema knows about. A trigger on
-- `auth.users` would fire before the profile exists and produce members with no
-- display name — which is exactly the state the roster query renders as
-- "Someone".

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
     and c.required_clearance_id is null   -- ungated only. See the note above.
  on conflict (chat_id, user_id) do nothing;

  return new;
end;
$$;

create trigger profiles_join_default_groups
  after insert on public.profiles
  for each row
  execute function private.join_default_groups();

comment on function private.join_default_groups() is
  'Adds a new profile to every group with no clearance requirement, so a fresh '
  'account does not land on an empty workspace. Gated groups are untouched.';
