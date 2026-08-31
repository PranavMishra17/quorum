#!/usr/bin/env -S npx tsx
/**
 * Run a scenario file against the real agent pipeline and print what happened.
 *
 *   pnpm scenario scenarios/memory-isolation.json
 *   pnpm scenario scenarios/clearance-floor.json
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT EXISTS SEPARATELY FROM `pnpm test`
 *
 * `tests/` proves the authorisation and memory RULES against a real Postgres,
 * as an unprivileged role — that is the load-bearing proof, and it needs no
 * model call to run. `scripts/verify-live.mjs` proves the APPLICATION reads
 * the database correctly, in a real browser, also without a model call.
 *
 * Neither of those lets you hand the system a scenario you made up and watch
 * the REAL agent — real gate, real memory retrieval, real Claude call — decide
 * what to do with it. This does exactly that: it seeds whatever chats and
 * people a JSON file describes, sends the scripted messages through the same
 * `send_message_and_start_turn()` RPC the app uses, and calls `runTurn()` —
 * the same function `app/api/chats/[chatId]/messages/route.ts` calls — directly.
 * Nothing here is a stub or a simulation; it is the production pipeline with a
 * script standing in for a browser.
 *
 * This costs real Anthropic API calls and creates real accounts, so it refuses
 * to run with `NODE_ENV=production` — the same guard `seed-dev.mjs` uses, and
 * for the same reason: this is a sandbox for exploring behaviour against
 * whatever project `.env.local` points at, not something to run against a
 * live deployment by habit.
 *
 * ---------------------------------------------------------------------------
 * SCENARIO FILE SHAPE
 *
 * {
 *   "name": "one line describing what this demonstrates",
 *   "users": [{ "key": "alice", "name": "Alice", "clearance": "confidential" }],
 *   "chats": [
 *     { "key": "solo",  "type": "agent", "members": ["alice"] },
 *     { "key": "team",  "type": "group", "name": "Team", "members": ["alice","bob"],
 *       "clearance": "confidential" }
 *   ],
 *   "turns": [
 *     { "chat": "solo", "from": "alice", "message": "I only review contracts on Fridays." },
 *     { "chat": "team", "from": "alice", "message": "@quorum when do I review contracts?" }
 *   ]
 * }
 *
 * `type: "dm"` needs exactly two members; `"agent"` needs exactly one — the
 * same rule the schema itself enforces, so a scenario that gets this wrong
 * fails with the database's own constraint error rather than a silent no-op.
 * `clearance` on a user is a grant; on a chat it's the required level. Both
 * are optional and default to none / general.
 */

import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { runTurn } from '../lib/agent/orchestrator';
import { describeEvent, type EventRow, type CallRow } from '../app/_components/event-trace';
import type { Database } from '../lib/db/rows';

config({ path: '.env.local', quiet: true });

const BASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!BASE_URL || !SECRET || !ANON || !process.env.ANTHROPIC_API_KEY) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and\n' +
      'ANTHROPIC_API_KEY are all required — this drives the real pipeline, not a mock.',
  );
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to run a scenario with NODE_ENV=production');
  process.exit(1);
}

const args = process.argv.slice(2);
const scenarioPath = args.find((a) => !a.startsWith('--'));
if (!scenarioPath) {
  console.error('usage: pnpm scenario <path-to-scenario.json>');
  process.exit(1);
}

interface ScenarioUser { key: string; name: string; clearance?: string }
interface ScenarioChat {
  key: string; type: 'dm' | 'group' | 'agent'; name?: string;
  members: string[]; clearance?: string;
}
interface ScenarioTurn { chat: string; from: string; message: string }
interface Scenario {
  name: string; users: ScenarioUser[]; chats: ScenarioChat[]; turns: ScenarioTurn[];
}

const scenario: Scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));

const admin = createClient<Database>(BASE_URL, SECRET, { auth: { persistSession: false } });

async function clearanceIds(): Promise<Record<string, string>> {
  const { data, error } = await admin.from('clearances').select('id, key');
  if (error) throw new Error(`could not read clearances: ${error.message}`);
  return Object.fromEntries(data.map((c) => [c.key, c.id]));
}

/** One admin client (for setup) and one signed-in client per user (to act as them). */
type ScopedClient = ReturnType<typeof createClient<Database>>;

async function ensureUser(u: ScenarioUser, runId: string): Promise<{ id: string; client: ScopedClient }> {
  const email = `${runId}.${u.key}@scenario.quorum.dev`;
  const password = randomUUID();

  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: u.name },
  });
  if (error) throw new Error(`could not create ${u.key}: ${error.message}`);
  const id = data.user.id;

  // is_demo excludes these from the Directory, New-group, and clearance
  // lists, and — combined with the chats/page.tsx discovery filter — from
  // showing up as "not a member" clutter in every real user's Workspace.
  // Found the hard way: an earlier run without this flag left "alice"/"bob"
  // scenario accounts auto-joined into real ungated groups and their throwaway
  // rooms visible to every other user, indistinguishable from real people.
  await admin.from('profiles').upsert({ id, display_name: u.name, color: '#61afef', is_demo: true });

  const client = createClient<Database>(BASE_URL!, ANON!, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign in ${u.key}: ${signInError.message}`);

  return { id, client };
}

async function main() {
  console.log(`\n▸ ${scenario.name}\n`);
  const runId = `run${Date.now().toString(36)}`;
  const clearance = await clearanceIds();

  const users = new Map<string, { id: string; client: ScopedClient }>();
  for (const u of scenario.users) {
    users.set(u.key, await ensureUser(u, runId));
    if (u.clearance) {
      await admin.from('user_clearances').insert({
        user_id: users.get(u.key)!.id, clearance_id: clearance[u.clearance],
      });
    }
  }
  console.log(`  ${users.size} user(s) created.`);

  const chats = new Map<string, string>();
  for (const c of scenario.chats) {
    const creator = users.get(c.members[0])!.id;
    const { data, error } = await admin
      .from('chats')
      .insert({
        type: c.type,
        name: c.name ?? null,
        created_by: creator,
        required_clearance_id: c.clearance ? clearance[c.clearance] : null,
        // Same reason as the profile flag above: an ungated scenario group
        // is otherwise a real, permanently-discoverable "not a member" tile
        // in every other user's Workspace, forever.
        is_demo: true,
      })
      .select('id')
      .single();
    if (error) throw new Error(`could not create chat "${c.key}": ${error.message}`);
    chats.set(c.key, data.id);

    await admin.from('chat_members').insert(
      c.members.map((m) => ({
        chat_id: data.id, user_id: users.get(m)!.id, status: 'member',
        role: m === c.members[0] ? 'admin' : 'member',
      })),
    );
  }
  console.log(`  ${chats.size} chat(s) created.\n`);

  for (const [i, t] of scenario.turns.entries()) {
    const chatId = chats.get(t.chat);
    const actor = users.get(t.from);
    if (!chatId || !actor) throw new Error(`turn ${i}: unknown chat "${t.chat}" or user "${t.from}"`);

    console.log(`  [${t.chat}] ${t.from}: ${t.message}`);

    const { data, error } = await actor.client.rpc('send_message_and_start_turn', {
      p_chat_id: chatId,
      p_content: t.message,
      p_client_message_id: randomUUID(),
    });
    if (error) {
      console.log(`    ✗ send failed: ${error.message}\n`);
      continue;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { message_id: string; turn_id: string };

    const result = await runTurn({
      chatId, actorId: actor.id, turnId: row.turn_id,
      requestId: randomUUID(), messageId: row.message_id,
    });

    const [{ data: events }, { data: calls }] = await Promise.all([
      admin.from('agent_events').select('id, turn_id, event_type, payload, created_at')
        .eq('turn_id', row.turn_id).order('created_at'),
      admin.from('llm_calls').select('id, turn_id, purpose, model, status, input_tokens, output_tokens, cost_estimate')
        .eq('turn_id', row.turn_id),
    ]);

    for (const e of (events ?? []) as unknown as EventRow[]) {
      console.log(`    · ${e.event_type}: ${describeEvent(e)}`);
    }

    if (result.spoke && result.agentMessageId) {
      const { data: reply } = await admin.from('messages').select('content')
        .eq('id', result.agentMessageId).single();
      console.log(`    → agent: "${reply?.content}"`);
    } else {
      console.log(`    → agent stayed silent (${result.decision.rule})`);
    }

    const cost = ((calls ?? []) as unknown as CallRow[])
      .reduce((n, c) => n + Number(c.cost_estimate ?? 0), 0);
    if (cost > 0) console.log(`    ($${cost.toFixed(4)})`);
    console.log('');
  }

  console.log('Done. Scenario accounts and chats are real rows — nothing here is cleaned up');
  console.log('automatically; re-run against the same project and a fresh run id makes a new set.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
