-- 0008 — seed the clearance ladder.
--
-- Must stay in step with CLEARANCES in config/agent.ts. Asserted by
-- tests/authorization/ladder.test.ts, so the two cannot drift silently.
--
-- ONE dimension: how sensitive the material is. Nothing here names a team, a
-- department, or who is in the room — that conflation was D-023, and it
-- produced a real bug where an `internal` fact was eligible to surface into an
-- `external_audit` chat purely because 2 > 1. Teams are chat_members' job.

insert into public.clearances (key, name, level, description) values
  ('general',      'General',      0, 'Default. No restriction.'),
  ('internal',     'Internal',     1, 'Not to leave the organisation.'),
  ('confidential', 'Confidential', 2, 'Need-to-know within the organisation.'),
  ('restricted',   'Restricted',   3, 'Highest sensitivity. Explicit grant only.')
on conflict (key) do update
  set name        = excluded.name,
      level       = excluded.level,
      description = excluded.description;
