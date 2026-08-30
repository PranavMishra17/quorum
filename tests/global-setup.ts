import { config } from 'dotenv';

/**
 * Runs ONCE, before any test file.
 *
 * Its only job is to say loudly when the authorization suites are not actually
 * running. The trap this closes: a reviewer runs `pnpm test`, sees green, and
 * concludes the RLS and authorization claims are verified. Without a database
 * they were skipped — and a silent skip is indistinguishable from a pass.
 *
 * Written with process.stderr.write rather than console.warn because Vitest
 * intercepts console output from setup files and swallows it.
 */
export default function globalSetup() {
  config({ path: '.env.local', quiet: true });

  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      '\n\x1b[33m  ⚠  DATABASE_URL is not set — authorization and RLS suites are SKIPPED.\n' +
        '     A green run here does NOT mean the authorization claims are verified.\n' +
        '     Run `supabase start`, or see the `database` job in .github/workflows/ci.yml.\x1b[0m\n\n',
    );
  }
}
