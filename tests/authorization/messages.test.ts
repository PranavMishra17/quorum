import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { asUser, asAnon, asSuper } from '../db/harness';
import {
  seedUsers, seedClearances, createChat, addMember, grantClearance, removeMember,
  truncateAll, type UserMap, type ClearanceMap,
} from '../db/fixtures';

/**
 * Content authorisation, plus the idempotency RPC.
 *
 * The membership and clearance suites prove the axes on chat metadata. These
 * prove them on the thing that actually matters — what people said.
 */

let admin: Client;
let u: UserMap;
let cl: ClearanceMap;
let openChat: string;
let gatedChat: string;

beforeAll(async () => {
  admin = await asSuper();
  await truncateAll(admin);
  cl = await seedClearances(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol', 'Dave']);
  await grantClearance(admin, u.Alice, cl.restricted);
  await grantClearance(admin, u.Bob, cl.confidential);

  openChat = await createChat(admin, { type: 'group', name: 'Open', createdBy: u.Alice });
  await addMember(admin, openChat, u.Alice, { role: 'admin' });
  await addMember(admin, openChat, u.Bob);

  gatedChat = await createChat(admin, {
    type: 'group', name: 'Gated', createdBy: u.Alice, requiredClearanceId: cl.restricted,
  });
  await addMember(admin, gatedChat, u.Alice, { role: 'admin' });
  await addMember(admin, gatedChat, u.Bob);   // member, but only confidential(2)
  await addMember(admin, gatedChat, u.Dave);  // member, no clearance

  await admin.query(
    `insert into public.messages (chat_id, sender_type, sender_id, content)
     values ($1,'user',$2,'hello from the open chat')`, [openChat, u.Alice]);
  await admin.query(
    `insert into public.messages (chat_id, sender_type, sender_id, content)
     values ($1,'user',$2,'restricted material')`, [gatedChat, u.Alice]);
  await admin.query(
    `insert into public.messages (chat_id, sender_type, content)
     values ($1,'agent','the agent speaking')`, [openChat]);
});

afterAll(async () => { await admin?.end(); });

async function as<T>(userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await asUser(userId);
  try { return await fn(c); } finally { await c.end(); }
}

const countIn = (chat: string) => async (c: Client) =>
  (await c.query('select count(*)::int n from public.messages where chat_id=$1', [chat])).rows[0].n;

describe('reading messages', () => {
  it('a member reads the chat history', async () => {
    expect(await as(u.Bob, countIn(openChat))).toBe(2);
  });

  it('a non-member reads nothing', async () => {
    expect(await as(u.Carol, countIn(openChat))).toBe(0);
  });

  it('signed out reads nothing', async () => {
    const c = await asAnon();
    try {
      expect((await c.query('select count(*)::int n from public.messages')).rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('a member WITHOUT clearance cannot read a gated chat\'s messages', async () => {
    // Both are full members. Only clearance separates them.
    expect(await as(u.Bob, countIn(gatedChat))).toBe(0);
    expect(await as(u.Dave, countIn(gatedChat))).toBe(0);
    expect(await as(u.Alice, countIn(gatedChat))).toBe(1);
  });

  it('a removed member loses the history on their next read', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'Ephemeral', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice, { role: 'admin' });
    await addMember(admin, chat, u.Carol);
    await admin.query(
      `insert into public.messages (chat_id, sender_type, sender_id, content)
       values ($1,'user',$2,'seen while a member')`, [chat, u.Alice]);

    expect(await as(u.Carol, countIn(chat))).toBe(1);
    await removeMember(admin, chat, u.Carol);
    // The stricter of the two defensible readings, per assumption 2.
    expect(await as(u.Carol, countIn(chat))).toBe(0);
  });
});

describe('writing messages', () => {
  it('a member can post', async () => {
    await as(u.Bob, async (c) => {
      const r = await c.query(
        `insert into public.messages (chat_id, sender_type, sender_id, content)
         values ($1,'user',$2,'hi') returning id`, [openChat, u.Bob]);
      expect(r.rowCount).toBe(1);
    });
  });

  it('a non-member cannot post', async () => {
    const err = await as(u.Carol, async (c) =>
      c.query(`insert into public.messages (chat_id, sender_type, sender_id, content)
               values ($1,'user',$2,'intruding')`, [openChat, u.Carol])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/row-level security/i);
  });

  it('a member cannot post AS someone else', async () => {
    const err = await as(u.Bob, async (c) =>
      c.query(`insert into public.messages (chat_id, sender_type, sender_id, content)
               values ($1,'user',$2,'forged')`, [openChat, u.Alice])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/row-level security/i);
  });

  it('NO client can put words in the agent\'s mouth', async () => {
    // There is no policy admitting sender_type='agent'. The agent speaks only
    // through the server-side scoped path.
    const err = await as(u.Alice, async (c) =>
      c.query(`insert into public.messages (chat_id, sender_type, content)
               values ($1,'agent','I am definitely the agent')`, [openChat])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/row-level security/i);
  });

  it('messages cannot be edited or deleted by anyone', async () => {
    await as(u.Alice, async (c) => {
      const upd = await c.query(
        `update public.messages set content='rewritten' where chat_id=$1 returning id`, [openChat])
        .catch(() => ({ rowCount: 0 }));
      expect(upd.rowCount).toBe(0);
      const del = await c.query(
        `delete from public.messages where chat_id=$1 returning id`, [openChat])
        .catch(() => ({ rowCount: 0 }));
      expect(del.rowCount).toBe(0);
    });
  });
});

describe('send_message_and_start_turn — idempotency', () => {
  const send = (chat: string, content: string, key: string) => async (c: Client) =>
    (await c.query(
      `select * from public.send_message_and_start_turn($1,$2,$3)`, [chat, content, key])).rows[0];

  it('a first delivery creates a message and a turn', async () => {
    const r = await as(u.Bob, send(openChat, 'first', 'key-001'));
    expect(r.is_duplicate).toBe(false);
    expect(r.message_id).toBeTruthy();
    expect(r.turn_id).toBeTruthy();
  });

  it('a retry returns the ORIGINAL turn_id and creates nothing', async () => {
    const first = await as(u.Bob, send(openChat, 'retryable', 'key-002'));
    const again = await as(u.Bob, send(openChat, 'retryable', 'key-002'));

    expect(again.is_duplicate).toBe(true);
    expect(again.message_id).toBe(first.message_id);
    // Resuming the same turn is what stops a retried request producing a
    // second agent reply.
    expect(again.turn_id).toBe(first.turn_id);

    const n = (await admin.query(
      `select count(*)::int n from public.messages where chat_id=$1 and client_message_id='key-002'`,
      [openChat])).rows[0].n;
    expect(n).toBe(1);
  });

  it('the same key in a DIFFERENT chat is a different message', async () => {
    const other = await createChat(admin, { type: 'group', name: 'Other', createdBy: u.Bob });
    await addMember(admin, other, u.Bob, { role: 'admin' });
    const a = await as(u.Bob, send(openChat, 'x', 'key-shared'));
    const b = await as(u.Bob, send(other, 'x', 'key-shared'));
    expect(a.message_id).not.toBe(b.message_id);
    expect(b.is_duplicate).toBe(false);
  });

  it('refuses a chat the caller cannot access — it checks BOTH axes itself', async () => {
    // SECURITY DEFINER bypasses RLS, so the function must authorise on its own.
    // Carol is not a member of openChat.
    const err = await as(u.Carol, async (c) =>
      c.query(`select * from public.send_message_and_start_turn($1,$2,$3)`,
        [openChat, 'sneaking in', 'key-evil'])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/not authorised/i);
  });

  it('refuses on the clearance axis too, for a full member', async () => {
    // Bob is a MEMBER of gatedChat but only holds confidential(2).
    const err = await as(u.Bob, async (c) =>
      c.query(`select * from public.send_message_and_start_turn($1,$2,$3)`,
        [gatedChat, 'under-cleared', 'key-clear'])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/not authorised/i);
  });

  it('requires an idempotency key', async () => {
    const err = await as(u.Bob, async (c) =>
      c.query(`select * from public.send_message_and_start_turn($1,$2,$3)`,
        [openChat, 'no key', null])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/client_message_id is required/i);
  });
});

describe('the public RPC surface', () => {
  it('can_access_chat_for is NOT callable by a signed-in client', async () => {
    // It takes BOTH ids as parameters, so a client holding it could enumerate
    // the entire authorisation matrix — "can user X see chat Y" for every pair.
    // Granted to service_role only.
    const err = await as(u.Bob, async (c) =>
      c.query('select public.can_access_chat_for($1,$2)', [gatedChat, u.Alice])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/permission denied/i);
  });

  it('and it returns the same verdict as both axes together', async () => {
    // Alice is a cleared member; Bob is an under-cleared member; Carol is neither.
    const check = async (user: string, chat: string) =>
      (await admin.query('select public.can_access_chat_for($1,$2) ok', [chat, user])).rows[0].ok;
    expect(await check(u.Alice, gatedChat)).toBe(true);
    expect(await check(u.Bob, gatedChat)).toBe(false);
    expect(await check(u.Carol, openChat)).toBe(false);
    expect(await check(u.Bob, openChat)).toBe(true);
  });
});

describe('agent_events and llm_calls', () => {
  beforeAll(async () => {
    await admin.query(
      `insert into public.agent_events (chat_id, turn_id, request_id, event_type, payload)
       values ($1, gen_random_uuid(), gen_random_uuid(), 'gate_evaluated', '{"verdict":"silent"}'::jsonb)`,
      [openChat]);
    await admin.query(
      `insert into public.agent_events (chat_id, turn_id, request_id, event_type)
       values ($1, gen_random_uuid(), gen_random_uuid(), 'gate_evaluated')`, [gatedChat]);
    await admin.query(
      `insert into public.llm_calls (chat_id, turn_id, request_id, model, tier, purpose)
       values ($1, gen_random_uuid(), gen_random_uuid(), 'claude-sonnet-5','judge','gate_judge')`,
      [openChat]);
  });

  it('a member can read the internal view for their chat', async () => {
    const n = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.agent_events where chat_id=$1', [openChat])).rows[0].n);
    expect(n).toBe(1);
  });

  it('a non-member cannot', async () => {
    const n = await as(u.Carol, async (c) =>
      (await c.query('select count(*)::int n from public.agent_events')).rows[0].n);
    expect(n).toBe(0);
  });

  it('an under-cleared member cannot read a gated chat\'s events', async () => {
    const n = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.agent_events where chat_id=$1', [gatedChat])).rows[0].n);
    expect(n).toBe(0);
  });

  it('the audit trail is append-only — no client can write or erase it', async () => {
    await as(u.Alice, async (c) => {
      const ins = await c.query(
        `insert into public.agent_events (chat_id, turn_id, request_id, event_type)
         values ($1, gen_random_uuid(), gen_random_uuid(), 'forged')`, [openChat])
        .then(() => 'ok').catch((e: Error) => e.message);
      expect(ins).toMatch(/row-level security/i);

      const del = await c.query(`delete from public.agent_events where chat_id=$1 returning id`, [openChat])
        .catch(() => ({ rowCount: 0 }));
      expect(del.rowCount).toBe(0);
    });
  });

  it('cost rows follow the same rule as the events', async () => {
    expect(await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.llm_calls where chat_id=$1', [openChat])).rows[0].n)).toBe(1);
    expect(await as(u.Carol, async (c) =>
      (await c.query('select count(*)::int n from public.llm_calls')).rows[0].n)).toBe(0);
  });

  it('an llm_calls row cannot claim to be finished without a finish time', async () => {
    await expect(admin.query(
      `insert into public.llm_calls (chat_id, turn_id, request_id, model, tier, purpose, status)
       values ($1, gen_random_uuid(), gen_random_uuid(), 'm','t','p','succeeded')`, [openChat]),
    ).rejects.toThrow(/finished_calls_have_a_finish/i);
  });
});
