-- 0018 — put the accounts that already existed into the ungated groups too.
--
-- 0017 added a trigger so NEW profiles join every group with no clearance
-- requirement. It deliberately did not backfill, and the reason given was that
-- `memory_audience` snapshots are taken against membership at learn time, so a
-- retroactive join would "silently change who counts as having been in the
-- room".
--
-- ---------------------------------------------------------------------------
-- THAT REASONING WAS WRONG, IN THE SAFE DIRECTION, AND IT IS WORTH SAYING SO
--
-- Adding somebody to a chat today does NOT rewrite any snapshot. Snapshots are
-- rows in `memory_audience`, written once and never updated. What actually
-- happens is the opposite of a leak:
--
--   The surfacing rule requires EVERY active member of a chat to appear in an
--   item's audience. A new member is in no old snapshot, so every memory
--   learned in that room before they joined immediately STOPS surfacing there.
--
-- That is the rule working, fail-closed, exactly as designed — the cost is that
-- the room forgets things, not that the newcomer learns them. Which is a
-- product tradeoff to state, not a safety reason to refuse.
--
-- So the honest position: backfilling is safe, and the previous comment was
-- over-cautious. It is corrected here rather than quietly reversed, because a
-- migration that contradicts the one before it should say which of the two was
-- mistaken.
--
-- Still ungated groups only. A gated group needs a clearance grant AND somebody
-- to add you; auto-joining those would hand every existing account both
-- authorisation axes at once and make the model decorative.
--
-- Idempotent, so re-running it is a no-op rather than a duplicate-key error.

insert into public.chat_members (chat_id, user_id, role, status)
select c.id, p.id, 'member', 'member'
  from public.chats c
 cross join public.profiles p
 where c.type = 'group'
   and c.required_clearance_id is null
on conflict (chat_id, user_id) do nothing;
