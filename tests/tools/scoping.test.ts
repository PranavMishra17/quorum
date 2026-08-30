import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { asUser, asSuper } from '../db/harness';
import {
  seedUsers, seedClearances, createChat, addMember, grantClearance, truncateAll,
  type UserMap, type ClearanceMap,
} from '../db/fixtures';

/**
 * Tool resource scoping.
 *
 * The claim under test: permission to INVOKE a tool is not permission to reach
 * every resource that tool could touch. A file tool that resolves an id without
 * authorising THAT resource is a confused deputy — the agent acts with more
 * authority than the user who invoked it.
 *
 * These assert the data-layer half. The application half is the invariant that
 * no ScopedAgentContext method accepts a scope-defining id as a parameter.
 */

let admin: Client;
let u: UserMap;
let cl: ClearanceMap;
let chatA: string;
let chatB: string;
let gated: string;
let fileInA: string;

beforeAll(async () => {
  admin = await asSuper();
  await truncateAll(admin);
  cl = await seedClearances(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol']);
  await grantClearance(admin, u.Alice, cl.restricted);

  chatA = await createChat(admin, { type: 'group', name: 'A', createdBy: u.Alice });
  await addMember(admin, chatA, u.Alice, { role: 'admin' });
  await addMember(admin, chatA, u.Bob);

  chatB = await createChat(admin, { type: 'group', name: 'B', createdBy: u.Carol });
  await addMember(admin, chatB, u.Carol, { role: 'admin' });
  await addMember(admin, chatB, u.Bob); // Bob is in BOTH

  gated = await createChat(admin, {
    type: 'group', name: 'Gated', createdBy: u.Alice, requiredClearanceId: cl.restricted });
  await addMember(admin, gated, u.Alice, { role: 'admin' });
  await addMember(admin, gated, u.Bob); // member, but no clearance

  const r = await admin.query(
    `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
     values ($1,$2,$3,'contract.pdf','application/pdf',1024) returning id`,
    [chatA, u.Alice, `${chatA}/contract.pdf`]);
  fileInA = r.rows[0].id;

  await admin.query(
    `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
     values ($1,$2,$3,'other.pdf','application/pdf',2048)`,
    [chatB, u.Carol, `${chatB}/other.pdf`]);

  await admin.query(
    `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
     values ($1,$2,$3,'secret.pdf','application/pdf',512)`,
    [gated, u.Alice, `${gated}/secret.pdf`]);
});

afterAll(async () => { await admin?.end(); });

async function as<T>(userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await asUser(userId);
  try { return await fn(c); } finally { await c.end(); }
}

describe('a file is scoped to the chat it was uploaded in', () => {
  it('a file uploaded in chat A is NOT retrievable from chat B', async () => {
    // Bob is a member of BOTH chats — so this cannot pass by accident of him
    // lacking access somewhere. Asking for A's file while scoped to B must fail.
    const n = await as(u.Bob, async (c) =>
      (await c.query(
        'select count(*)::int n from public.files where id=$1 and chat_id=$2',
        [fileInA, chatB])).rows[0].n);
    expect(n).toBe(0);
  });

  it('a non-member of A cannot read A\'s file even by exact id', async () => {
    // The confused-deputy case: knowing the resource id must not be enough.
    const n = await as(u.Carol, async (c) =>
      (await c.query('select count(*)::int n from public.files where id=$1', [fileInA])).rows[0].n);
    expect(n).toBe(0);
  });

  it('a member of A can read A\'s file', async () => {
    const n = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.files where id=$1', [fileInA])).rows[0].n);
    expect(n).toBe(1);
  });

  it('each member sees only the files of chats they can access', async () => {
    expect(await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.files')).rows[0].n)).toBe(2);
    expect(await as(u.Carol, async (c) =>
      (await c.query('select count(*)::int n from public.files')).rows[0].n)).toBe(1);
    expect(await as(u.Alice, async (c) =>
      (await c.query('select count(*)::int n from public.files')).rows[0].n)).toBe(2);
  });

  it('clearance gates files too — membership alone is not enough', async () => {
    // Bob is a full member of the gated chat but holds no clearance.
    const n = await as(u.Bob, async (c) =>
      (await c.query('select count(*)::int n from public.files where chat_id=$1', [gated])).rows[0].n);
    expect(n).toBe(0);
  });
});

describe('uploading', () => {
  it('a member can upload to their chat', async () => {
    await as(u.Bob, async (c) => {
      const r = await c.query(
        `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
         values ($1,$2,$3,'notes.txt','text/plain',10) returning id`,
        [chatA, u.Bob, `${chatA}/notes.txt`]);
      expect(r.rowCount).toBe(1);
    });
  });

  it('a non-member cannot upload into someone else\'s chat', async () => {
    const err = await as(u.Carol, async (c) =>
      c.query(
        `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
         values ($1,$2,$3,'evil.txt','text/plain',10)`,
        [chatA, u.Carol, `${chatA}/evil.txt`])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/row-level security/i);
  });

  it('a member cannot upload AS another user', async () => {
    const err = await as(u.Bob, async (c) =>
      c.query(
        `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
         values ($1,$2,$3,'forged.txt','text/plain',10)`,
        [chatA, u.Alice, `${chatA}/forged.txt`])
        .then(() => null).catch((e: Error) => e.message));
    expect(err).toMatch(/row-level security/i);
  });

  it('the storage path MUST be chat-scoped — the storage policy depends on it', async () => {
    // The bucket policy derives the chat id from the first path segment. A row
    // whose path does not start with its chat id would be authorised by the
    // table and mis-authorised by the bucket.
    await expect(
      admin.query(
        `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
         values ($1,$2,$3,'sneaky.txt','text/plain',10)`,
        [chatA, u.Alice, `${chatB}/sneaky.txt`]),
    ).rejects.toThrow(/storage_path_is_chat_scoped/i);
  });
});

describe('deleting', () => {
  it('an uploader may withdraw their own file', async () => {
    const r = await admin.query(
      `insert into public.files (chat_id, uploader_id, storage_path, filename, mime_type, size_bytes)
       values ($1,$2,$3,'mine.txt','text/plain',10) returning id`,
      [chatA, u.Bob, `${chatA}/mine.txt`]);
    await as(u.Bob, async (c) => {
      const d = await c.query('delete from public.files where id=$1 returning id', [r.rows[0].id]);
      expect(d.rowCount).toBe(1);
    });
  });

  it('a member cannot delete someone else\'s file', async () => {
    await as(u.Bob, async (c) => {
      const d = await c.query('delete from public.files where id=$1 returning id', [fileInA])
        .catch(() => ({ rowCount: 0 }));
      expect(d.rowCount).toBe(0);
    });
  });

  it('the file record cannot be rewritten by anyone', async () => {
    await as(u.Alice, async (c) => {
      const upd = await c.query(
        `update public.files set chat_id=$1 where id=$2 returning id`, [chatB, fileInA])
        .catch(() => ({ rowCount: 0 }));
      // Re-pointing a file at another chat would be a one-statement leak.
      expect(upd.rowCount).toBe(0);
    });
  });
});
