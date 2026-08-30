/**
 * Single import surface for configuration.
 *
 *   import { TIERS, GATE, MEMORY } from '@/config';
 *
 * No magic numbers anywhere else in the codebase. If a threshold appears
 * inline in lib/ or app/, that is a review comment.
 */

export * from './models';
export * from './agent';
export { clientEnv, serverEnv, isConfigured, type ClientEnv, type ServerEnv } from './env';
