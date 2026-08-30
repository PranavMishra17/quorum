import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * Authorisation and RLS tests talk to a real Postgres as an unprivileged
     * role. Running them in parallel against shared fixture rows produces
     * flakes that look exactly like authorisation bugs, which is the worst
     * possible kind of flake to have in this project.
     */
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, '.') },
  },
});
