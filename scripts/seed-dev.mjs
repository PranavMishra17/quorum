#!/usr/bin/env node
/**
 * Seed the development world.
 *
 *   pnpm seed:dev
 *
 * Creates the five dev accounts, grants their clearances, and builds a set of
 * chats chosen so that the authorisation model is visible in a single glance at
 * the chat list rather than requiring a walkthrough.
 *
 * Idempotent — safe to run repeatedly.
 *
 * Refuses to run against production. It creates accounts with a known shared
 * password, which is fine in a dev project and is an incident anywhere else.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env.local; rely on the ambient environment.
  }
}
loadEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to seed a production environment');
  process.exit(1);
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!URL || !SECRET) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required.\n' +
      'Copy .env.example to .env.local and fill it in — see docs/SETUP-SUPABASE.md.',
  );
  process.exit(1);
}

const db = createClient(URL, SECRET, { auth: { persistSession: false } });

const PASSWORD = 'quorum-dev-password-not-a-secret';

const USERS = [
  { key: 'alice', email: 'alice@quorum.dev', name: 'Alice Nakamura', clearance: 'restricted' },
  { key: 'bob',   email: 'bob@quorum.dev',   name: 'Bob Oyelaran',   clearance: 'confidential' },
  { key: 'carol', email: 'carol@quorum.dev', name: 'Carol Whitfield', clearance: 'internal' },
  { key: 'dana',  email: 'dana@quorum.dev',  name: 'Dana Iqbal',     clearance: null },
  { key: 'erin',  email: 'erin@quorum.dev',  name: 'Erin Vasquez',   clearance: 'general' },
];

const PALETTE = ['#e06c75', '#d19a66', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#be5046'];
const colorFor = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

async function upsertUser(u) {
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users?.find((x) => x.email === u.email);
  if (existing) return existing.id;

  const { data, error } = await db.auth.admin.createUser({
    email: u.email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: u.name },
  });
  if (error) throw new Error(`createUser ${u.email}: ${error.message}`);
  return data.user.id;
}

async function chat(spec) {
  const { data: found } = await db
    .from('chats').select('id').eq('name', spec.name).maybeSingle();
  if (found) return found.id;

  const { data, error } = await db
    .from('chats')
    .insert({
      type: spec.type,
      name: spec.name,
      created_by: spec.createdBy,
      required_clearance_id: spec.clearanceId ?? null,
    })
    .select('id').single();
  if (error) throw new Error(`chat ${spec.name}: ${error.message}`);
  return data.id;
}

async function member(chatId, userId, role = 'member') {
  const { error } = await db
    .from('chat_members')
    .upsert(
      { chat_id: chatId, user_id: userId, role, status: 'member', joined_at: new Date().toISOString() },
      { onConflict: 'chat_id,user_id' },
    );
  if (error) throw new Error(`member: ${error.message}`);
}

async function say(chatId, senderId, content) {
  const { data: existing } = await db
    .from('messages').select('id').eq('chat_id', chatId).eq('content', content).maybeSingle();
  if (existing) return;
  const { error } = await db
    .from('messages')
    .insert({ chat_id: chatId, sender_type: 'user', sender_id: senderId, content });
  if (error) throw new Error(`message: ${error.message}`);
}

async function main() {
  const { data: clearances, error: clErr } = await db.from('clearances').select('id, key, level');
  if (clErr) throw new Error(`clearances: ${clErr.message} — have migrations been applied?`);
  const byKey = Object.fromEntries(clearances.map((c) => [c.key, c]));
  if (!byKey.restricted) throw new Error('clearance ladder is not seeded; apply migration 0008');

  const id = {};
  for (const u of USERS) {
    id[u.key] = await upsertUser(u);
    await db.from('profiles').upsert(
      { id: id[u.key], display_name: u.name, color: colorFor(id[u.key]) },
      { onConflict: 'id' },
    );
    if (u.clearance) {
      await db.from('user_clearances').upsert(
        { user_id: id[u.key], clearance_id: byKey[u.clearance].id },
        { onConflict: 'user_id,clearance_id' },
      );
    }
    console.log(`  user  ${u.key.padEnd(6)} ${u.clearance ?? '(no clearance)'}`);
  }

  // --- The demo world -------------------------------------------------------
  // Each chat exists to make one claim visible without explanation.

  // 1 & 2. IDENTICAL member sets, different levels. This is the pair that makes
  // the clearance floor non-redundant: containment holds both ways, so only the
  // floor stops a deal-room fact surfacing in the general room.
  const dealRoom = await chat({
    type: 'group', name: 'Deal Room', createdBy: id.alice, clearanceId: byKey.confidential.id });
  await member(dealRoom, id.alice, 'admin');
  await member(dealRoom, id.bob);

  const watercooler = await chat({ type: 'group', name: 'Watercooler', createdBy: id.alice });
  await member(watercooler, id.alice, 'admin');
  await member(watercooler, id.bob);

  // 3. Membership WITHOUT clearance. Dana is a full member and still sees
  // nothing — the axis-independence demo.
  const legalOps = await chat({
    type: 'group', name: 'Legal Ops', createdBy: id.alice, clearanceId: byKey.confidential.id });
  await member(legalOps, id.alice, 'admin');
  await member(legalOps, id.bob);
  await member(legalOps, id.dana);

  // 4. An ordinary group, so the list is not entirely edge cases.
  const general = await chat({ type: 'group', name: 'General', createdBy: id.carol });
  await member(general, id.carol, 'admin');
  await member(general, id.alice);
  await member(general, id.bob);
  await member(general, id.dana);

  // 5. A DM — never discoverable by anyone else.
  const dm = await chat({ type: 'dm', name: null, createdBy: id.alice });
  await member(dm, id.alice);
  await member(dm, id.carol);

  // Erin joins nothing: the "a third session sees nothing" control.

  await say(watercooler, id.alice, 'Morning. Anyone else fighting the coffee machine?');
  await say(watercooler, id.bob, 'It has won again.');
  await say(dealRoom, id.alice, 'Draft terms are in. Governing law is still open.');
  await say(legalOps, id.alice, 'Dana is on the roster but not cleared yet.');
  await say(general, id.carol, 'Welcome everybody.');
  await say(dm, id.alice, 'Quick one, just between us.');

  console.log('\n  chats seeded:');
  console.log('    Deal Room   confidential  Alice, Bob        (paired with Watercooler)');
  console.log('    Watercooler general       Alice, Bob        (identical members, level 0)');
  console.log('    Legal Ops   confidential  Alice, Bob, Dana  (Dana: member, no clearance)');
  console.log('    General     general       Carol, Alice, Bob, Dana');
  console.log('    DM          —             Alice, Carol');
  console.log('    Erin is in nothing — the "sees nothing" control.');
  console.log(`\n  sign in at /auth/dev?user=alice  (needs ALLOW_DEV_LOGIN=true)\n`);
}

main().catch((err) => {
  console.error(`\nseed failed: ${err.message}\n`);
  process.exit(1);
});
