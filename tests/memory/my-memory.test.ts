import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { asUser, asAnon, asSuper } from '../db/harness';
import {
  seedUsers, createChat, addMember, learnMemory, truncateAll, type UserMap,
} from '../db/fixtures';

/**
 * `public.my_memory()` — migration 0019.
 *
 * This is a DELIBERATE hole in the "no client reads memory" rule, and the
 * whole point of this suite is to prove the hole is exactly the shape it is
 * supposed to be: a person may read rows where THEY are the subject, and
 * nothing else. It must never become a second `retrieve.ts` — it ignores the
 * surfacing rule on purpose, because "what does it know about me" and "what
 * may it say in this room" are different questions with different correct
 * answers for the very same row.
 */

let admin: Client;
let u: UserMap;

beforeAll(async () => { admin = await asSuper(); });
afterAll(async () => { await admin?.end(); });

beforeEach(async () => {
  await truncateAll(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol']);
});

async function myMemoryAs(userId: string) {
  const c = await asUser(userId);
  try {
    return (await c.query('select * from public.my_memory()')).rows;
  } finally {
    await c.end();
  }
}

describe('a user sees only items ABOUT THEMSELVES', () => {
  it('returns a fact learned about the caller', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'reviews on Fridays' });

    const rows = await myMemoryAs(u.Alice);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('reviews on Fridays');
  });

  it('does NOT return a fact about somebody else in the same chat', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await learnMemory(admin, { subject: u.Bob, originChat: dm, content: 'about Bob, not Alice' });

    expect(await myMemoryAs(u.Alice)).toHaveLength(0);
  });

  it('does not leak between two unrelated users at all', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'alice fact' });
    await learnMemory(admin, { subject: u.Bob, originChat: dm, content: 'bob fact' });

    const aliceRows = await myMemoryAs(u.Alice);
    const bobRows = await myMemoryAs(u.Bob);
    expect(aliceRows.map((r) => r.content)).toEqual(['alice fact']);
    expect(bobRows.map((r) => r.content)).toEqual(['bob fact']);
  });

  it('is unreachable anonymously', async () => {
    const c = await asAnon();
    try {
      await expect(c.query('select * from public.my_memory()')).rejects.toThrow();
    } finally {
      await c.end();
    }
  });

  it('takes no parameter that could be pointed at someone else', async () => {
    // The invariant this whole design rests on: no argument, so no injection
    // vector, so no way to ask for anyone's memory but your own.
    // parameter_mode = 'IN' excludes the OUT columns RETURNS TABLE(...) produces
    // — those show up in this view too, and would make every function here
    // look like it takes eleven arguments.
    const { rows } = await admin.query(
      `select count(*)::int n from information_schema.parameters p
         join information_schema.routines r on r.specific_name = p.specific_name
        where r.routine_name = 'my_memory' and r.routine_schema = 'public'
          and p.parameter_mode = 'IN'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('it deliberately ignores the surfacing rule — this is the SUBJECT, not a reader', () => {
  it('returns an item even after the audience has all left', async () => {
    // Empty active membership is the fail-closed trap for RETRIEVAL (T1). It
    // must NOT also blank the subject's own view of their history — that would
    // be the same bug wearing the opposite disguise: hiding a fact from the one
    // person it is unambiguously about.
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    const id = await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'still mine' });
    await admin.query(`update public.chat_members set status='removed' where chat_id=$1`, [dm]);

    const rows = await myMemoryAs(u.Alice);
    expect(rows.map((r) => r.id)).toContain(id);
  });

  it('returns a candidate item, unlike retrieval which never would', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await learnMemory(admin, {
      subject: u.Alice, originChat: dm, content: 'low confidence guess',
      status: 'candidate', confidence: 0.2,
    });
    const rows = await myMemoryAs(u.Alice);
    expect(rows.map((r) => r.status)).toContain('candidate');
  });

  it('returns a superseded item, so the subject can see their own history', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    const oldId = await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'old fact' });
    const newId = await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'new fact' });
    // A CHECK constraint requires a superseded row to name its replacement —
    // "superseded and points nowhere" is not a state the schema admits.
    await admin.query(
      `update public.memory_items set status='superseded', superseded_by=$2 where id=$1`,
      [oldId, newId],
    );

    const rows = await myMemoryAs(u.Alice);
    expect(rows.find((r) => r.id === oldId)?.status).toBe('superseded');
    expect(rows.find((r) => r.id === oldId)?.superseded_by).toBe(newId);
  });

  it('does not require the caller to still be a member of the origin chat', async () => {
    // A gated chat the subject has since lost clearance for is still a chat
    // they WERE in when the fact was learned. Being unable to open the room
    // must not also erase their record of what was said about them there.
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'from a chat I left' });
    await admin.query(
      `update public.chat_members set status='removed' where chat_id=$1 and user_id=$2`,
      [dm, u.Alice],
    );

    expect(await myMemoryAs(u.Alice)).toHaveLength(1);
  });
});

describe('the audience count is reported, without naming who is in it', () => {
  it('reports how many people were in the room, not their identities', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'x' });

    const rows = await myMemoryAs(u.Alice);
    expect(rows[0].audience_size).toBe(2);
    expect(Object.keys(rows[0])).not.toContain('audience_user_ids');
  });

  it('reflects a group audience larger than two', async () => {
    const group = await createChat(admin, { type: 'group', createdBy: u.Alice, name: 'G' });
    await addMember(admin, group, u.Alice);
    await addMember(admin, group, u.Bob);
    await addMember(admin, group, u.Carol);
    await learnMemory(admin, { subject: u.Alice, originChat: group, content: 'x' });

    const rows = await myMemoryAs(u.Alice);
    expect(rows[0].audience_size).toBe(3);
  });
});
