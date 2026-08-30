import { describe, it } from 'vitest';

/**
 * Tool authorization.
 *
 * The claim under test: permission to INVOKE a tool is not permission to reach
 * every resource that tool could touch. Because `execute` receives a
 * ScopedAgentContext and has no other route to the database, resource-level
 * authorization should be structural rather than remembered.
 *
 * These tests exist to catch the case where it is not.
 */
describe('tool resource scoping', () => {
  it.todo('a file uploaded in chat A is not retrievable from chat B');
  it.todo('a file read resolves the resource and authorises THAT resource');
  it.todo('a tool cannot reach the database except through the scoped context');
  it.todo('a tool invoked in a chat the actor cannot access is refused');
  it.todo('storage bucket policies deny a direct URL fetch by a non-member');
});

describe('tool bounds', () => {
  it.todo('the tool loop stops at maxCallsPerTurn');
  it.todo('the tool loop stops at maxWallClockMs');
  it.todo('a repeated identical tool call is not executed twice');
  it.todo('a tool timeout is surfaced as an event, not swallowed');
});

describe('untrusted content', () => {
  it.todo('tool output is fenced with provenance before entering context');
  it.todo('a tool result cannot authorise a further privileged tool call');
  it.todo('content fetched from the web is never treated as an instruction');
});
