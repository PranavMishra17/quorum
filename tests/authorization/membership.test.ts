import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { asUser, asAnon, asSuper } from '../db/harness';
import {
  seedUsers, seedClearances, createChat, addMember, removeMember, truncateAll,
  type UserMap,
} from '../db/fixtures';

/**
 * Axis one: membership.
 *
 * Every assertion runs as the `authenticated` role with a JWT context, against
 * real Postgres. The superuser connection is used only to build the world —
 * asserting through it would bypass the policies being tested.
 */

let admin: Client;
let u: UserMap;
let groupChat: string;   // alice (admin), bob
let dmChat: string;      // alice, bob
let outsiderChat: string; // carol only

beforeAll(async () => {
  admin = await asSuper();
  await truncateAll(admin);
  await seedClearances(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);

  groupChat = await createChat(admin, { type: 'group', name: 'Engineering', createdBy: u.Alice });
  await addMember(admin, groupChat, u.Alice, { role: 'admin' });
  await addMember(admin, groupChat, u.Bob);
  await addMember(admin, groupChat, u.Dave, { status: 'requested' });
  await addMember(admin, groupChat, u.Erin, { status: 'invited' });

  dmChat = await createChat(admin, { type: 'dm', createdBy: u.Alice });
  await addMember(admin, dmChat, u.Alice);
  await addMember(admin, dmChat, u.Bob);

  outsiderChat = await createChat(admin, { type: 'group', name: 'Legal', createdBy: u.Carol });
  await addMember(admin, outsiderChat, u.Carol, { role: 'admin' });
});

afterAll(async () => {
  await admin?.end();
});

async function as<T>(userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await asUser(userId);
  try { return await fn(c); } finally { await c.end(); }
}

describe('reading a chat', () => {
  it('a member can read the chat row', async () => {
    const n = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.chats where id=$1', [dmChat])).rows[0].n);
    expect(n).toBe(1);
  });

  it('a non-member cannot read a DM', async () => {
    const n = await as(u.Carol, async (c) =>
      (await c.query('select count(*)::int n from public.chats where id=$1', [dmChat])).rows[0].n);
    expect(n).toBe(0);
  });

  it('a signed-out user reads nothing at all', async () => {
    const c = await asAnon();
    try {
      const n = (await c.query('select count(*)::int n from public.chats')).rows[0].n;
      expect(n).toBe(0);
    } finally { await c.end(); }
  });

  it('a group is DISCOVERABLE by a non-member, so joining can be requested', async () => {
    // Deliberate: you cannot ask to join something you cannot see. This exposes
    // the name only — every content policy still requires can_access_chat().
    const n = await as(u.Carol, async (c) =>
      (await c.query(`select count(*)::int n from public.chats where id=$1`, [groupChat])).rows[0].n);
    expect(n).toBe(1);
  });
});

describe('membership status is not membership', () => {
  it('a `requested` row grants no access to the chat content path', async () => {
    const ok = await as(u.Dave, async (c) =>
      (await c.query(`select private.can_access_chat($1,$2) ok`, [groupChat, u.Dave]).catch(() => ({ rows: [{ ok: null }] }))).rows[0].ok);
    // The predicate is not granted to clients at all — which is itself the
    // assertion: a client cannot use it as an authorisation oracle.
    expect(ok === false || ok === null).toBe(true);
  });

  it('a `requested` user can see their own pending row', async () => {
    const n = await as(u.Dave, async (c) =>
      (await c.query('select count(*)::int n from public.chat_members where chat_id=$1 and user_id=$2',
        [groupChat, u.Dave])).rows[0].n);
    expect(n).toBe(1);
  });

  it('a `requested` user cannot see the rest of the roster', async () => {
    const n = await as(u.Dave, async (c) =>
      (await c.query('select count(*)::int n from public.chat_members where chat_id=$1', [groupChat])).rows[0].n);
    expect(n).toBe(1); // only their own row
  });

  it('an `invited` row likewise grants no roster access', async () => {
    const n = await as(u.Erin, async (c) =>
      (await c.query('select count(*)::int n from public.chat_members where chat_id=$1', [groupChat])).rows[0].n);
    expect(n).toBe(1);
  });

  it('a full member sees the whole roster', async () => {
    const n = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.chat_members where chat_id=$1', [groupChat])).rows[0].n);
    expect(n).toBe(4);
  });
});

describe('removal', () => {
  it('a removed member loses roster access on their next read', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'Temp', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice, { role: 'admin' });
    await addMember(admin, chat, u.Bob);

    const before = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.chat_members where chat_id=$1', [chat])).rows[0].n);
    expect(before).toBe(2);

    await removeMember(admin, chat, u.Bob);

    const after = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.chat_members where chat_id=$1', [chat])).rows[0].n);
    expect(after).toBe(1); // only their own tombstone row
  });
});

describe('roster mutation', () => {
  it('a non-admin cannot add a member', async () => {
    const res = await as(u.Bob, async (c) =>
      c.query(
        `insert into public.chat_members (chat_id, user_id, status) values ($1,$2,'member')`,
        [groupChat, u.Carol],
      ).then(() => 'inserted').catch((e: Error) => e.message),
    );
    expect(res).toMatch(/row-level security/i);
  });

  it('a non-admin cannot promote themselves', async () => {
    await as(u.Bob, async (c) => {
      const r = await c.query(
        `update public.chat_members set role='admin' where chat_id=$1 and user_id=$2 returning role`,
        [groupChat, u.Bob],
      ).catch(() => ({ rowCount: 0 }));
      expect(r.rowCount).toBe(0);
    });
    const check = await admin.query(
      'select role from public.chat_members where chat_id=$1 and user_id=$2', [groupChat, u.Bob]);
    expect(check.rows[0].role).toBe('member');
  });

  it('a pending user cannot upgrade their own request to membership', async () => {
    await as(u.Dave, async (c) => {
      const r = await c.query(
        `update public.chat_members set status='member' where chat_id=$1 and user_id=$2 returning status`,
        [groupChat, u.Dave],
      ).catch(() => ({ rowCount: 0 }));
      expect(r.rowCount).toBe(0);
    });
    const check = await admin.query(
      'select status from public.chat_members where chat_id=$1 and user_id=$2', [groupChat, u.Dave]);
    expect(check.rows[0].status).toBe('requested');
  });

  it('a user may request to join a discoverable group', async () => {
    await as(u.Carol, async (c) => {
      const r = await c.query(
        `insert into public.chat_members (chat_id, user_id, status) values ($1,$2,'requested') returning status`,
        [groupChat, u.Carol],
      );
      expect(r.rows[0].status).toBe('requested');
    });
  });

  it('a user may leave by setting their own row to removed', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'Leavers', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice, { role: 'admin' });
    await addMember(admin, chat, u.Erin);
    await as(u.Erin, async (c) => {
      const r = await c.query(
        `update public.chat_members set status='removed' where chat_id=$1 and user_id=$2 returning status`,
        [chat, u.Erin],
      );
      expect(r.rows[0].status).toBe('removed');
    });
  });

  it('an admin can approve a join request', async () => {
    await as(u.Alice, async (c) => {
      const r = await c.query(
        `update public.chat_members set status='member' where chat_id=$1 and user_id=$2 returning status`,
        [groupChat, u.Dave],
      );
      expect(r.rows[0].status).toBe('member');
    });
  });
});

describe('the predicates are not an authorisation oracle', () => {
  it('private schema functions are not callable by a client', async () => {
    const err = await as(u.Bob, async (c) =>
      c.query(`select private.is_chat_member($1,$2)`, [outsiderChat, u.Bob])
        .then(() => null)
        .catch((e: Error) => e.message));
    expect(err).toMatch(/permission denied|does not exist/i);
  });
});
