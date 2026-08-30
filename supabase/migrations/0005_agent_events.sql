-- 0005 — agent_events and llm_calls: the agent's audit trail.
--
-- Both are append-only and written exclusively by the server-side scoped path.
-- Clients read them (that is the whole point of the internal view) and can
-- never write them.

create table public.agent_events (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references public.chats(id) on delete cascade,
  -- Correlates every row produced by one agent turn. The trace IS this join;
  -- there is deliberately no `traces` table.
  turn_id    uuid not null,
  -- The delivery attempt. A retry resumes the same turn_id under a NEW
  -- request_id, so without this the trace cannot tell "one turn, two delivery
  -- attempts" from "one attempt".
  request_id uuid not null,
  message_id uuid references public.messages(id) on delete set null,
  event_type text not null,
  -- jsonb so a new event type is a new string and a payload shape, never a
  -- migration. Step-boundary events carry duration_ms here rather than being
  -- split into paired _started/_completed rows.
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index agent_events_chat_idx on public.agent_events (chat_id, created_at desc);
create index agent_events_turn_idx on public.agent_events (turn_id, created_at);

alter table public.agent_events enable row level security;

-- Readable by anyone who can access the chat. This is what powers the internal
-- view, and showing it to users is deliberate: an agent whose reasoning is
-- inspectable is the strongest artifact in the project.
create policy agent_events_select
  on public.agent_events for select
  to authenticated
  using (private.can_access_chat(chat_id, (select auth.uid())));

-- No insert, update or delete policy for any client. Append-only, server-only.

-- ---------------------------------------------------------------------------
-- llm_calls
-- ---------------------------------------------------------------------------

create type public.llm_call_status as enum ('started', 'succeeded', 'failed');

create table public.llm_calls (
  id             uuid primary key default gen_random_uuid(),
  chat_id        uuid not null references public.chats(id) on delete cascade,
  turn_id        uuid not null,
  request_id     uuid not null,
  message_id     uuid references public.messages(id) on delete set null,
  model          text not null,
  tier           text not null,
  purpose        text not null,
  -- The row is INSERTed with status 'started' BEFORE the network call, then
  -- updated. A row written only on success is missing exactly when it matters
  -- most: a crash between "Anthropic charged us" and "row inserted" leaves no
  -- trace and the retry pays again. That is a money bug, not a tidiness one —
  -- and it is why there is no latency_ms column, since a duration cannot be
  -- written before the call returns.
  status         public.llm_call_status not null default 'started',
  input_tokens   int,
  output_tokens  int,
  cost_estimate  numeric(12, 6),
  error_type     text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),

  constraint finished_calls_have_a_finish
    check (status = 'started' or finished_at is not null)
);

create index llm_calls_chat_idx on public.llm_calls (chat_id, created_at desc);
-- Checked before every model call to detect "this turn already paid".
create index llm_calls_turn_idx on public.llm_calls (turn_id);

alter table public.llm_calls enable row level security;

create policy llm_calls_select
  on public.llm_calls for select
  to authenticated
  using (private.can_access_chat(chat_id, (select auth.uid())));

-- No client write policy.
