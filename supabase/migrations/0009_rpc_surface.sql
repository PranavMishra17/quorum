-- 0009 — the public RPC surface the server-side scoped path needs.
--
-- The authorisation predicates live in `private`, which PostgREST does not
-- expose, and that is correct: a client must not be able to call them as an
-- authorisation oracle. But `lib/db/scoped-agent.ts` legitimately needs to
-- re-check authorisation on every privileged read (D-009), and it reaches the
-- database over PostgREST like everything else.
--
-- So: a thin public wrapper, granted to `service_role` ONLY. Adding it here
-- rather than editing 0003 because migrations are append-only.

create or replace function public.can_access_chat_for(
  p_chat_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_access_chat(p_chat_id, p_user_id)
$$;

-- The grant is the whole point. `authenticated` must never reach this: it takes
-- BOTH ids as parameters, so a client holding it could enumerate the entire
-- authorisation matrix — "can user X see chat Y" for every X and Y.
--
-- Note this is exactly the shape the ScopedAgentContext invariant forbids in
-- application code. It is acceptable here because the caller is the server-side
-- path that already knows both ids from the turn it opened, and because the
-- function is unreachable by anyone else.
revoke all on function public.can_access_chat_for(uuid, uuid) from public;
grant execute on function public.can_access_chat_for(uuid, uuid) to service_role;
