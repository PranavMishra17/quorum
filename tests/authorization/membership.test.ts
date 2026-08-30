import { describe, it } from 'vitest';

/**
 * Axis one: membership.
 *
 * These run against a REAL Postgres as an UNPRIVILEGED role, with a JWT
 * context set per test. Running them through a service-role client would test
 * nothing at all — that key bypasses the thing under test.
 *
 * Harness setup is research track R12.
 */
describe('membership authorization', () => {
  describe('reads', () => {
    it.todo('a non-member cannot read a chat row');
    it.todo('a non-member cannot read the chat\'s messages');
    it.todo('a non-member cannot read the chat\'s agent_events');
    it.todo('a non-member cannot read the chat\'s llm_calls');
    it.todo('a non-member cannot read the chat\'s files');
    it.todo('a member can read all of the above');
  });

  describe('writes', () => {
    it.todo('a non-member cannot insert a message into the chat');
    it.todo('a member cannot insert a message attributed to another user');
    it.todo('no client can insert a message with sender_type = agent');
  });

  describe('status transitions', () => {
    it.todo('a requested membership row grants no read access');
    it.todo('an invited membership row grants no read access');
    it.todo('a removed member loses access from the moment of removal');
    it.todo('a removed member cannot read history that was visible to them before');
    it.todo('a user may create their own membership row with status = requested');
    it.todo('a user may set their own row to removed in order to leave');
    it.todo('a user cannot set their own row to member');
  });

  describe('memory tables are unreachable from any client', () => {
    it.todo('the authenticated role cannot select from memory_items');
    it.todo('the authenticated role cannot select from memory_audience');
    it.todo('the authenticated role cannot insert into memory_items');
  });
});
