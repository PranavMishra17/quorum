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

/**
 * Learn a memory item, snapshotting the audience exactly as extraction will:
 * the ACTIVE members of the origin chat at this instant.
 *
 * Taking the snapshot here rather than passing it in is deliberate — it means
 * the tests exercise the same "who was in the room" logic the real extractor
 * must, instead of asserting against a hand-written audience that could quietly
 * disagree with production.
 */
export async function learnMemory(
  admin: Client,
  opts: {
    subject: string;
    originChat: string;
    content: string;
    clearanceLevel?: number;
    sourceType?: 'stated' | 'inferred';
    confidence?: number;
    status?: 'candidate' | 'active' | 'superseded' | 'stale';
    expiresAt?: string | null;
    /** Override the snapshot. Only for testing the empty-audience edge case. */
    audience?: string[];
  },
): Promise<string> {
  const res = await admin.query(
    `insert into public.memory_items
       (subject_user_id, origin_chat_id, content, clearance_level,
        source_type, confidence, status, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id`,
    [
      opts.subject, opts.originChat, opts.content, opts.clearanceLevel ?? 0,
      opts.sourceType ?? 'stated', opts.confidence ?? 0.9,
      opts.status ?? 'active', opts.expiresAt ?? null,
    ],
  );
  const id = res.rows[0].id as string;

  if (opts.audience) {
    for (const userId of opts.audience) {
      await admin.query(
        `insert into public.memory_audience (memory_item_id, user_id) values ($1,$2)`,
        [id, userId],
      );
    }
  } else {
    await admin.query(
      `insert into public.memory_audience (memory_item_id, user_id)
       select $1, m.user_id from public.chat_members m
       where m.chat_id = $2 and m.status = 'member'`,
      [id, opts.originChat],
    );
  }
  return id;
}

/** What the surfacing rule admits into a given chat. Server-side path only. */
export async function visibleMemory(admin: Client, chatId: string): Promise<string[]> {
  const res = await admin.query(
    `select content from private.memory_visible_in_chat($1) order by content`,
    [chatId],
  );
  return res.rows.map((r) => r.content as string);
}

/** Wipe all fixture data between suites, leaving the schema intact. */
export async function truncateAll(admin: Client): Promise<void> {
  await admin.query(`
    truncate public.memory_audience, public.memory_items,
             public.agent_events, public.llm_calls, public.messages,
             public.chat_members, public.chats, public.user_clearances,
             public.connector_tokens,
             public.profiles restart identity cascade;
    delete from auth.users;
  `);
}
