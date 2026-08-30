import type { Client } from 'pg';

/**
 * Fixture builders. All writes go through a superuser connection, deliberately:
 * setting up a world is not the thing under test, and forcing fixtures through
 * the policies would mean a policy bug could make a test pass by preventing the
 * scenario from existing at all.
 *
 * Assertions must never use the superuser connection. See tests/db/harness.ts.
 */

export type UserMap = Record<string, string>;
export type ClearanceMap = Record<string, string>;

/** Create auth.users + profiles rows. Returns name -> uuid. */
export async function seedUsers(admin: Client, names: string[]): Promise<UserMap> {
  const out: UserMap = {};
  for (const name of names) {
    const res = await admin.query(
      `insert into auth.users (email) values ($1) returning id`,
      [`${name.toLowerCase()}@test.local`],
    );
    const id = res.rows[0].id as string;
    await admin.query(
      `insert into public.profiles (id, display_name) values ($1, $2)`,
      [id, name],
    );
    out[name] = id;
  }
  return out;
}

/** Seed the sensitivity ladder from config. Returns key -> uuid. */
export async function seedClearances(admin: Client): Promise<ClearanceMap> {
  const rungs = [
    ['general', 'General', 0],
    ['internal', 'Internal', 1],
    ['confidential', 'Confidential', 2],
    ['restricted', 'Restricted', 3],
  ] as const;
  const out: ClearanceMap = {};
  for (const [key, name, level] of rungs) {
    const res = await admin.query(
      `insert into public.clearances (key, name, level) values ($1,$2,$3)
       on conflict (key) do update set name = excluded.name
       returning id`,
      [key, name, level],
    );
    out[key] = res.rows[0].id as string;
  }
  return out;
}

export async function grantClearance(
  admin: Client,
  userId: string,
  clearanceId: string,
): Promise<void> {
  await admin.query(
    `insert into public.user_clearances (user_id, clearance_id) values ($1,$2)
     on conflict do nothing`,
    [userId, clearanceId],
  );
}

export async function createChat(
  admin: Client,
  opts: {
    type: 'dm' | 'group' | 'agent';
    createdBy: string;
    name?: string | null;
    requiredClearanceId?: string | null;
  },
): Promise<string> {
  const res = await admin.query(
    `insert into public.chats (type, name, created_by, required_clearance_id)
     values ($1,$2,$3,$4) returning id`,
    [opts.type, opts.name ?? null, opts.createdBy, opts.requiredClearanceId ?? null],
  );
  return res.rows[0].id as string;
}

export async function addMember(
  admin: Client,
  chatId: string,
  userId: string,
  opts: { role?: 'admin' | 'member'; status?: 'member' | 'requested' | 'invited' | 'removed' } = {},
): Promise<void> {
  await admin.query(
    `insert into public.chat_members (chat_id, user_id, role, status, joined_at)
     values ($1,$2,$3,$4, now())
     on conflict (chat_id, user_id) do update
       set role = excluded.role, status = excluded.status`,
    [chatId, userId, opts.role ?? 'member', opts.status ?? 'member'],
  );
}

export async function removeMember(
  admin: Client,
  chatId: string,
  userId: string,
): Promise<void> {
  await admin.query(
    `update public.chat_members set status = 'removed', removed_at = now()
     where chat_id = $1 and user_id = $2`,
    [chatId, userId],
  );
}

/** Wipe all fixture data between suites, leaving the schema intact. */
export async function truncateAll(admin: Client): Promise<void> {
  await admin.query(`
    truncate public.chat_members, public.chats, public.user_clearances,
             public.profiles restart identity cascade;
    delete from auth.users;
  `);
}
