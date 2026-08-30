-- 0004 — messages, idempotency, and the one multi-statement transaction.

create type public.sender_type as enum ('user', 'agent');

create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  chat_id           uuid not null references public.chats(id) on delete cascade,
  sender_type       public.sender_type not null,
  -- NULL for agent messages: the agent is not a row in auth.users.
  sender_id         uuid references auth.users(id) on delete set null,
  content           text not null check (length(content) between 1 and 20000),
  -- Client-generated idempotency key. NULL for agent messages, and NULLs are
  -- distinct in a unique constraint, so the agent can speak as often as it
  -- likes without colliding.
  client_message_id text,
  -- Correlates every agent_events and llm_calls row produced by this message.
  turn_id           uuid not null default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  constraint user_messages_have_sender
    check ((sender_type = 'user') = (sender_id is not null)),
  -- No TTL on the key. Stripe expires idempotency keys at 24h because keys are
  -- a scarce resource in a payments system; a text column on a row that
  -- persists anyway is not.
  constraint messages_client_id_unique
    unique (chat_id, client_message_id)
);

create index messages_chat_created_idx on public.messages (chat_id, created_at desc);
create index messages_turn_idx on public.messages (turn_id);

alter table public.messages enable row level security;

create policy messages_select
  on public.messages for select
  to authenticated
  using (private.can_access_chat(chat_id, (select auth.uid())));

-- A client may only ever insert its own USER message, into a chat it can
-- access. There is deliberately no policy admitting sender_type = 'agent':
-- the agent speaks through the server-side scoped path, so a client cannot
-- forge words in the agent's mouth.
create policy messages_insert_own
  on public.messages for insert
  to authenticated
  with check (
    sender_type = 'user'
    and sender_id = (select auth.uid())
    and private.can_access_chat(chat_id, (select auth.uid()))
  );

-- No update or delete policy. Messages are the episodic record; editing them
-- would silently invalidate the audience snapshots taken from them.

-- ---------------------------------------------------------------------------
-- send_message_and_start_turn — the atomic entry point
--
-- `supabase-js` has no multi-statement transaction: every .from() call is its
-- own implicit transaction, and Supavisor's transaction-mode pooling means
-- session state does not survive between two of them. A client-side
-- "check for duplicate, then insert" is therefore a race, not a check.
--
-- A function call is a single statement, so its whole body runs in one
-- transaction. That, plus ON CONFLICT DO NOTHING, makes the insert idempotent
-- under concurrency.
--
-- A note on isolation, because the research recommended REPEATABLE READ here:
-- it is not needed for THIS operation and is not used. ON CONFLICT resolves the
-- only race that exists (two deliveries of the same client_message_id) at READ
-- COMMITTED, and REPEATABLE READ would add 40001 serialization failures and a
-- retry loop to buy nothing. Isolation is worth raising where a function reads
-- several tables and must see one consistent snapshot; this one does not.
--
-- SECURITY DEFINER means this bypasses RLS on the insert, so it performs the
-- authorisation check itself, first, and fails closed.
-- ---------------------------------------------------------------------------

create or replace function public.send_message_and_start_turn(
  p_chat_id           uuid,
  p_content           text,
  p_client_message_id text
)
returns table (message_id uuid, turn_id uuid, is_duplicate boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_turn uuid := gen_random_uuid();
  v_msg  uuid;
  v_existing_id   uuid;
  v_existing_turn uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Both axes, evaluated here and now — not read from a cached context.
  if not private.can_access_chat(p_chat_id, v_user) then
    raise exception 'not authorised for chat %', p_chat_id using errcode = '42501';
  end if;

  if p_client_message_id is null or length(p_client_message_id) = 0 then
    raise exception 'client_message_id is required' using errcode = '22023';
  end if;

  insert into public.messages
    (chat_id, sender_type, sender_id, content, client_message_id, turn_id)
  values
    (p_chat_id, 'user', v_user, p_content, p_client_message_id, v_turn)
  on conflict (chat_id, client_message_id) do nothing
  returning id into v_msg;

  if v_msg is not null then
    return query select v_msg, v_turn, false;
    return;
  end if;

  -- Duplicate delivery. Return the ORIGINAL turn_id so the retry resumes the
  -- same turn instead of starting a second one — which is what stops a retried
  -- request producing two agent replies.
  select m.id, m.turn_id into v_existing_id, v_existing_turn
  from public.messages m
  where m.chat_id = p_chat_id
    and m.client_message_id = p_client_message_id;

  return query select v_existing_id, v_existing_turn, true;
end
$$;

revoke all on function public.send_message_and_start_turn(uuid, text, text) from public;
grant execute on function public.send_message_and_start_turn(uuid, text, text) to authenticated;
