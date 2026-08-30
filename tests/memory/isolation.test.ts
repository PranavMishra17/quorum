import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { asUser, asSuper } from '../db/harness';
import {
  seedUsers, seedClearances, createChat, addMember, removeMember, grantClearance,
  learnMemory, visibleMemory, truncateAll, type UserMap, type ClearanceMap,
} from '../db/fixtures';

/**
 * THE TESTS THAT PROVE THE THESIS.
 *
 * The rule under test:
 *
 *   An item learned in chat C1 may surface in chat C2 only if
 *     (a) every active member of C2 was in the item's audience snapshot, AND
 *     (b) C2's clearance level >= the item's clearance level.
 *
 * These were written from that sentence as stated in the README, before
 * `lib/memory/retrieve.ts` existed. That ordering is the point: a test written
 * by reading the implementation confirms whatever the implementation does,
 * including the leak.
 */

let admin: Client;
let u: UserMap;
let cl: ClearanceMap;

beforeAll(async () => {
  admin = await asSuper();
});

afterAll(async () => { await admin?.end(); });

beforeEach(async () => {
  await truncateAll(admin);
  cl = await seedClearances(admin);
  u = await seedUsers(admin, ['Alice', 'Bob', 'Carol', 'Dave']);
});

// ---------------------------------------------------------------------------
// (a) Audience containment
// ---------------------------------------------------------------------------

describe('audience containment', () => {
  it('a DM secret does not surface in a group containing anyone outside that DM', async () => {
    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: dm, content: 'told in confidence' });

    const group = await createChat(admin, { type: 'group', name: 'Team', createdBy: u.Alice });
    await addMember(admin, group, u.Alice);
    await addMember(admin, group, u.Bob);
    await addMember(admin, group, u.Carol); // was not in the room

    expect(await visibleMemory(admin, group)).toEqual([]);
    // …and is still available where it was learned.
    expect(await visibleMemory(admin, dm)).toEqual(['told in confidence']);
  });

  it('surfaces in a chat whose members are a STRICT SUBSET of the audience', async () => {
    const group = await createChat(admin, { type: 'group', name: 'Big', createdBy: u.Alice });
    for (const n of ['Alice', 'Bob', 'Carol']) await addMember(admin, group, u[n]);
    await learnMemory(admin, { subject: u.Alice, originChat: group, content: 'known to three' });

    const dm = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, dm, u.Alice);
    await addMember(admin, dm, u.Bob); // {Alice,Bob} ⊂ {Alice,Bob,Carol}

    expect(await visibleMemory(admin, dm)).toEqual(['known to three']);
  });

  it('does NOT surface where the member sets merely overlap', async () => {
    const a = await createChat(admin, { type: 'group', name: 'A', createdBy: u.Alice });
    await addMember(admin, a, u.Alice);
    await addMember(admin, a, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: a, content: 'overlap only' });

    const b = await createChat(admin, { type: 'group', name: 'B', createdBy: u.Alice });
    await addMember(admin, b, u.Bob);
    await addMember(admin, b, u.Carol); // Carol was never in the room

    expect(await visibleMemory(admin, b)).toEqual([]);
  });

  it('visibility never widens: adding a member REVOKES the item from that chat', async () => {
    const group = await createChat(admin, { type: 'group', name: 'Growing', createdBy: u.Alice });
    await addMember(admin, group, u.Alice);
    await addMember(admin, group, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: group, content: 'said among two' });
    expect(await visibleMemory(admin, group)).toEqual(['said among two']);

    await addMember(admin, group, u.Carol);
    // Carol was not present when it was said, so it stops surfacing HERE — the
    // audience may narrow, never widen.
    expect(await visibleMemory(admin, group)).toEqual([]);
  });

  it('a late joiner does not gain access to what was said before them', async () => {
    const group = await createChat(admin, { type: 'group', name: 'Before', createdBy: u.Alice });
    await addMember(admin, group, u.Alice);
    await addMember(admin, group, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: group, content: 'january fact' });

    await addMember(admin, group, u.Carol); // joins in March
    const carolDm = await createChat(admin, { type: 'dm', createdBy: u.Carol });
    await addMember(admin, carolDm, u.Carol);
    await addMember(admin, carolDm, u.Alice);

    expect(await visibleMemory(admin, carolDm)).toEqual([]);
  });

  it('a late joiner does not cause the item to be excluded ELSEWHERE', async () => {
    const group = await createChat(admin, { type: 'group', name: 'Origin', createdBy: u.Alice });
    await addMember(admin, group, u.Alice);
    await addMember(admin, group, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: group, content: 'still fine' });

    const other = await createChat(admin, { type: 'dm', createdBy: u.Alice });
    await addMember(admin, other, u.Alice);
    await addMember(admin, other, u.Bob);

    await addMember(admin, group, u.Carol); // pollutes the ORIGIN chat only
    expect(await visibleMemory(admin, other)).toEqual(['still fine']);
  });

  it('containment is evaluated against the SNAPSHOT, not current membership', async () => {
    const group = await createChat(admin, { type: 'group', name: 'Snapshot', createdBy: u.Alice });
    await addMember(admin, group, u.Alice);
    await addMember(admin, group, u.Bob);
    await addMember(admin, group, u.Carol);
    await learnMemory(admin, { subject: u.Alice, originChat: group, content: 'three heard it' });

    // Carol leaves. The snapshot still records that she heard it, and the
    // remaining members are a subset of it, so it remains visible.
    await removeMember(admin, group, u.Carol);
    expect(await visibleMemory(admin, group)).toEqual(['three heard it']);

    const snapshot = await admin.query(
      `select count(*)::int n from public.memory_audience`);
    expect(snapshot.rows[0].n).toBe(3); // immutable — Carol is still in it
  });
});

// ---------------------------------------------------------------------------
// (b) Clearance floor
// ---------------------------------------------------------------------------

describe('clearance floor', () => {
  /** Two chats, IDENTICAL member sets, different clearance levels. */
  async function twoChatsSameMembers() {
    const high = await createChat(admin, {
      type: 'group', name: 'Exec', createdBy: u.Alice, requiredClearanceId: cl.restricted });
    const low = await createChat(admin, {
      type: 'group', name: 'General', createdBy: u.Alice });
    for (const chat of [high, low]) {
      await addMember(admin, chat, u.Alice);
      await addMember(admin, chat, u.Bob);
    }
    await grantClearance(admin, u.Alice, cl.restricted);
    await grantClearance(admin, u.Bob, cl.restricted);
    return { high, low };
  }

  it('a level-3 fact does NOT surface in a level-0 chat with an IDENTICAL member set', async () => {
    // This is precisely why containment alone is insufficient, and why the
    // clearance floor is not redundant: the same two people share both chats,
    // so audience containment holds in both directions.
    const { high, low } = await twoChatsSameMembers();
    await learnMemory(admin, {
      subject: u.Alice, originChat: high, content: 'board discussion', clearanceLevel: 3 });

    expect(await visibleMemory(admin, high)).toEqual(['board discussion']);
    expect(await visibleMemory(admin, low)).toEqual([]);
  });

  it('a level-0 fact DOES surface in a level-3 chat', async () => {
    const { high, low } = await twoChatsSameMembers();
    await learnMemory(admin, {
      subject: u.Alice, originChat: low, content: 'ordinary fact', clearanceLevel: 0 });

    expect(await visibleMemory(admin, low)).toEqual(['ordinary fact']);
    expect(await visibleMemory(admin, high)).toEqual(['ordinary fact']);
  });

  it('the floor is >=, so an equal level passes', async () => {
    const { high } = await twoChatsSameMembers();
    await learnMemory(admin, {
      subject: u.Alice, originChat: high, content: 'exactly three', clearanceLevel: 3 });
    expect(await visibleMemory(admin, high)).toEqual(['exactly three']);
  });

  it('an ungated chat is level 0 and admits only level-0 facts', async () => {
    const open = await createChat(admin, { type: 'group', name: 'Open', createdBy: u.Alice });
    await addMember(admin, open, u.Alice);
    await learnMemory(admin, { subject: u.Alice, originChat: open, content: 'zero', clearanceLevel: 0 });
    await learnMemory(admin, { subject: u.Alice, originChat: open, content: 'one', clearanceLevel: 1 });
    expect(await visibleMemory(admin, open)).toEqual(['zero']);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

describe('fail-closed', () => {
  it('A CHAT WITH ZERO ACTIVE MEMBERS RETRIEVES NOTHING — NOT EVERYTHING', async () => {
    // The single highest-value test in this file.
    //
    // "Every active member of C2 was in the snapshot" is VACUOUSLY TRUE over an
    // empty member set. Without an explicit guard, a vacated chat matches every
    // memory item in the system — the exact leak this project exists to
    // prevent, arriving through the front door of its own central rule.
    const source = await createChat(admin, { type: 'group', name: 'Source', createdBy: u.Alice });
    await addMember(admin, source, u.Alice);
    await addMember(admin, source, u.Bob);
    await learnMemory(admin, { subject: u.Alice, originChat: source, content: 'secret one' });
    await learnMemory(admin, { subject: u.Bob, originChat: source, content: 'secret two' });

    const vacated = await createChat(admin, { type: 'group', name: 'Vacated', createdBy: u.Alice });
    await addMember(admin, vacated, u.Alice);
    await removeMember(admin, vacated, u.Alice); // nobody left

    expect(await visibleMemory(admin, vacated)).toEqual([]);
  });

  it('a chat that never had members retrieves nothing', async () => {
    const source = await createChat(admin, { type: 'group', name: 'S', createdBy: u.Alice });
    await addMember(admin, source, u.Alice);
    await learnMemory(admin, { subject: u.Alice, originChat: source, content: 'a secret' });

    const empty = await createChat(admin, { type: 'group', name: 'Empty', createdBy: u.Alice });
    expect(await visibleMemory(admin, empty)).toEqual([]);
  });

  it('a nonexistent chat retrieves nothing', async () => {
    const source = await createChat(admin, { type: 'group', name: 'S2', createdBy: u.Alice });
    await addMember(admin, source, u.Alice);
    await learnMemory(admin, { subject: u.Alice, originChat: source, content: 'a secret' });
    expect(await visibleMemory(admin, '00000000-0000-0000-0000-000000000000')).toEqual([]);
  });

  it('an item with an EMPTY audience snapshot surfaces nowhere', async () => {
    const chat = await createChat(admin, { type: 'group', name: 'C', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    await learnMemory(admin, {
      subject: u.Alice, originChat: chat, content: 'orphan', audience: [] });
    expect(await visibleMemory(admin, chat)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle gating
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  async function soloChat() {
    const chat = await createChat(admin, { type: 'group', name: 'Solo', createdBy: u.Alice });
    await addMember(admin, chat, u.Alice);
    return chat;
  }

  it('a candidate below the confidence threshold is never retrieved', async () => {
    const chat = await soloChat();
    await learnMemory(admin, {
      subject: u.Alice, originChat: chat, content: 'unsure', status: 'candidate', confidence: 0.2 });
    expect(await visibleMemory(admin, chat)).toEqual([]);
  });

  it('a superseded item is not retrieved', async () => {
    const chat = await soloChat();
    const newer = await learnMemory(admin, {
      subject: u.Alice, originChat: chat, content: 'lives in Berlin' });
    const older = await learnMemory(admin, {
      subject: u.Alice, originChat: chat, content: 'lives in Paris' });
    await admin.query(
      `update public.memory_items set status='superseded', superseded_by=$1 where id=$2`,
      [newer, older]);
    expect(await visibleMemory(admin, chat)).toEqual(['lives in Berlin']);
  });

  it('an expired item is not retrieved', async () => {
    const chat = await soloChat();
    await learnMemory(admin, {
      subject: u.Alice, originChat: chat, content: 'stale fact',
      expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    await learnMemory(admin, {
      subject: u.Alice, originChat: chat, content: 'fresh fact',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await visibleMemory(admin, chat)).toEqual(['fresh fact']);
  });

  it('a superseded item cannot exist without a pointer to what replaced it', async () => {
    const chat = await soloChat();
    const id = await learnMemory(admin, { subject: u.Alice, originChat: chat, content: 'x' });
    await expect(
      admin.query(`update public.memory_items set status='superseded' where id=$1`, [id]),
    ).rejects.toThrow(/superseded_items_point_somewhere/i);
  });
});

// ---------------------------------------------------------------------------
// The model can only leak what it is given — so nothing else may reach memory
// ---------------------------------------------------------------------------

describe('memory is unreachable from any client', () => {
  it('the authenticated role cannot read memory_items', async () => {
    const c = await asUser(u.Alice);
    try {
      await expect(c.query('select * from public.memory_items')).rejects.toThrow(/permission denied/i);
    } finally { await c.end(); }
  });

  it('the authenticated role cannot read memory_audience', async () => {
    const c = await asUser(u.Alice);
    try {
      await expect(c.query('select * from public.memory_audience')).rejects.toThrow(/permission denied/i);
    } finally { await c.end(); }
  });

  it('the authenticated role cannot write memory', async () => {
    const c = await asUser(u.Alice);
    try {
      await expect(
        c.query(`insert into public.memory_items
                 (subject_user_id, origin_chat_id, content, clearance_level, source_type, confidence)
                 values ($1,$1,'planted',0,'stated',1)`, [u.Alice]),
      ).rejects.toThrow(/permission denied/i);
    } finally { await c.end(); }
  });

  it('the surfacing function is not an oracle a client can query', async () => {
    const c = await asUser(u.Alice);
    try {
      await expect(
        c.query(`select * from private.memory_visible_in_chat($1)`, [
          '00000000-0000-0000-0000-000000000000']),
      ).rejects.toThrow(/permission denied|does not exist/i);
    } finally { await c.end(); }
  });
});
