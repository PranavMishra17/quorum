import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { asUser, asSuper } from '../db/harness';
import {
  seedUsers, seedClearances, createChat, addMember, removeMember,
  truncateAll, type UserMap, type ClearanceMap,
} from '../db/fixtures';

/**
 * The public RPC surface for memory.
 *
 * The filter lives in `private.memory_visible_in_chat()`, which PostgREST does
 * not expose. These wrappers are how the server-side path reaches it, so they
 * are the place a leak would be introduced — a wrapper that widened the filter,
 * or one granted to the wrong role, would defeat everything migration 0006 does.
 */

let admin: Client;
let u: UserMap;
let cl: ClearanceMap;

beforeAll(async () => { admin = await asSuper(); });
afterAll(async () => { await admin?.end(); });

beforeEach(async () => {
  await truncateAll(admin);
  cl = await seedClearances(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol']);
});

async function write(chatId: string, subject: string, content: string, over: {
  clearance?: number; source?: string; confidence?: number; status?: string; expires?: string | null;
} = {}) {
  const res = await admin.query(
    `select public.write_memory_item($1,$2,null,$3,$4,$5::public.memory_source,$6,$7::public.memory_status,$8) as id`,
    [subject, chatId, content, over.clearance ?? 0, over.source ?? 'stated',
     over.confidence ?? 0.9, over.status ?? 'active', over.expires ?? null],
  );
  return res.rows[0].id as string;
}

const visible = async (chatId: string, query = 'fact') =>
  (await admin.query(
    `select content, relevance from public.memory_for_chat($1,$2) order by content`, [chatId, query]))
    .rows as { content: string; relevance: number }[];

describe('write_memory_item is atomic', () => {
  it('writes the item and its audience snapshot together', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    await addMember(admin, chat, u.Bob);

    const id = await write(chat, u.Alice, 'a durable fact');

    const audience = await admin.query(
      'select user_id from public.memory_audience where memory_item_id=$1', [id]);
    expect(audience.rowCount).toBe(2);
  });

  it('snapshots only ACTIVE members, not pending or removed ones', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    await addMember(admin, chat, u.Bob, { status: 'requested' });
    await addMember(admin, chat, u.Carol);
    await removeMember(admin, chat, u.Carol);

    const id = await write(chat, u.Alice, 'only alice heard this');

    const audience = await admin.query(
      'select user_id from public.memory_audience where memory_item_id=$1', [id]);
    expect(audience.rows.map((r) => r.user_id)).toEqual([u.Alice]);
  });

  it('REFUSES to learn from a chat with no active members', async () => {
    // An item with an empty snapshot is unretrievable by construction, so
    // storing one is silent data loss. Refusing is clearer than writing a row
    // that can never surface.
    const chat = await createChat(admin, { type: 'group', name: 'Empty', createdBy: u.Alice });
    await expect(write(chat, u.Alice, 'shouted into the void'))
      .rejects.toThrow(/no active members/i);

    const items = await admin.query('select count(*)::int n from public.memory_items');
    expect(items.rows[0].n).toBe(0);
  });

  it('freezes the clearance level onto the item', async () => {
    const chat = await createChat(admin, {
      type: 'group', name: 'Gated', createdBy: u.Alice, requiredClearanceId: cl.confidential });
    await addMember(admin, chat, u.Alice);
    const id = await write(chat, u.Alice, 'sensitive', { clearance: 2 });

    // Changing the chat's requirement afterwards must NOT retroactively widen
    // what has already been learned.
    await admin.query('update public.chats set required_clearance_id = null where id = $1', [chat]);
    const row = await admin.query('select clearance_level from public.memory_items where id=$1', [id]);
    expect(row.rows[0].clearance_level).toBe(2);
  });
});

describe('memory_for_chat applies the same filter', () => {
  it('surfaces an item where the audience contains the chat', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    await write(chat, u.Alice, 'alice likes lists');
    expect((await visible(chat, 'lists')).map((r) => r.content)).toEqual(['alice likes lists']);
  });

  it('does NOT surface an item whose audience is missing a member', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await write(dm, u.Alice, 'told in confidence');

    const group = await createChat(admin, { type: 'group', name: 'Wider', createdBy: u.Alice });
    for (const n of ['Alice', 'Bob', 'Carol']) await addMember(admin, group, u[n]);

    expect(await visible(group, 'confidence')).toEqual([]);
  });

  it('applies the clearance floor', async () => {
    const high = await createChat(admin, {
      type: 'group', name: 'High', createdBy: u.Alice, requiredClearanceId: cl.restricted });
    const low = await createChat(admin, { type: 'group', name: 'Low', createdBy: u.Alice });
    for (const c of [high, low]) { await addMember(admin, c, u.Alice); await addMember(admin, c, u.Bob); }

    await write(high, u.Alice, 'board matter', { clearance: 3 });
    expect((await visible(high, 'board')).length).toBe(1);
    expect(await visible(low, 'board')).toEqual([]);
  });

  it('carries the fail-closed guard through the wrapper', async () => {
    const source = await createChat(admin, { type: 'group', name: 'S', createdBy: u.Alice });
    await addMember(admin, source, u.Alice);
    await write(source, u.Alice, 'a secret');

    const vacated = await createChat(admin, { type: 'group', name: 'V', createdBy: u.Alice });
    await addMember(admin, vacated, u.Alice);
    await removeMember(admin, vacated, u.Alice);

    expect(await visible(vacated, 'secret')).toEqual([]);
  });

  it('excludes candidate, superseded and expired items', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    await write(chat, u.Alice, 'active fact');
    await write(chat, u.Alice, 'candidate fact', { status: 'candidate' });
    await write(chat, u.Alice, 'expired fact', {
      expires: new Date(Date.now() - 86_400_000).toISOString() });

    expect((await visible(chat, 'fact')).map((r) => r.content)).toEqual(['active fact']);
  });
});

describe('relevance scoring', () => {
  it('scores a matching item above a non-matching one', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    await write(chat, u.Alice, 'alice prefers asynchronous review');
    await write(chat, u.Alice, 'bob dislikes early meetings');

    const rows = await visible(chat, 'asynchronous review');
    const match = rows.find((r) => r.content.includes('asynchronous'))!;
    const other = rows.find((r) => r.content.includes('meetings'))!;
    expect(match.relevance).toBeGreaterThan(other.relevance);
  });

  it('survives arbitrary punctuation in the query', async () => {
    // The query is a chat message, so it is arbitrary by definition.
    // websearch_to_tsquery tolerates this; plainto_/to_tsquery would raise.
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    await write(chat, u.Alice, 'a fact');

    for (const q of ['what?!', 'a & b | c', '"unclosed', ':: <-> !!', '']) {
      await expect(visible(chat, q)).resolves.toBeDefined();
    }
  });
});

describe('neither RPC is reachable by a client', () => {
  it('memory_for_chat is service_role only — it would be a complete oracle', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    const c = await asUser(u.Alice);
    try {
      await expect(c.query('select * from public.memory_for_chat($1,$2)', [chat, 'x']))
        .rejects.toThrow(/permission denied/i);
    } finally { await c.end(); }
  });

  it('write_memory_item is service_role only', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'G', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    const c = await asUser(u.Alice);
    try {
      await expect(c.query(
        `select public.write_memory_item($1,$2,null,'planted',0,'stated'::public.memory_source,1,'active'::public.memory_status,null)`,
        [u.Alice, chat],
      )).rejects.toThrow(/permission denied/i);
    } finally { await c.end(); }
  });
});
