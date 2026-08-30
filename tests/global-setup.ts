import { existsSync, readdirSync } from 'node:fs';
import { config } from 'dotenv';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { resetDatabase } from './db/harness';

/**
 * Starts a real PostgreSQL for the authorization suites. Runs once, before any
 * test file.
 *
 * No Docker. `embedded-postgres` ships genuine Postgres binaries and runs them
 * directly, which matters because the alternative — an in-JS Postgres emulator —
 * does not implement row-level security, and RLS is the thing under test. A
 * harness that cannot enforce a policy cannot verify one.
 *
 * If TEST_DATABASE_URL is already set (CI, or a local `supabase start`), that
 * database is used instead and nothing is spawned.
 */

const PORT = 54329;
const DATA_DIR = './.pgdata';

let instance: EmbeddedPostgres | null = null;

async function canConnect(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export default async function setup() {
  config({ path: '.env.local', quiet: true });

  const external = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (external) {
    process.env.TEST_DATABASE_URL = external;
    process.stderr.write('\n  ▸ using external database from TEST_DATABASE_URL\n');
    await resetDatabase();
    return;
  }

  const url = `postgresql://postgres:postgres@localhost:${PORT}/postgres`;

  // A server left running by a previous run is reusable — and much faster than
  // a fresh initdb. resetDatabase() drops everything either way, so a warm
  // instance cannot leak state between runs.
  if (await canConnect(url)) {
    process.env.TEST_DATABASE_URL = url;
    await resetDatabase();
    return;
  }

  instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: true,
  });

  // initdb refuses a non-empty directory and prints a wall of stderr doing so.
  // Checking first keeps a normal run quiet; a warm data dir is also much
  // faster than re-initialising, and resetDatabase() below guarantees the
  // schema is rebuilt regardless.
  const alreadyInitialised =
    existsSync(DATA_DIR) && readdirSync(DATA_DIR).length > 0;

  if (!alreadyInitialised) {
    process.stderr.write('  ▸ initialising embedded Postgres (first run only)…\n');
    await instance.initialise();
  }
  await instance.start();

  process.env.TEST_DATABASE_URL = url;
  await resetDatabase();

  return async () => {
    if (instance) await instance.stop();
  };
}
