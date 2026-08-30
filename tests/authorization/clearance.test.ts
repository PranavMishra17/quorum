import { describe, it } from 'vitest';

/**
 * Axis two: clearance.
 *
 * The point of these tests is that clearance is INDEPENDENT of membership. A
 * user with a perfectly valid membership row is still refused if they are not
 * badged for the chat. That independence is what makes the clearance floor in
 * the memory rule meaningful rather than redundant.
 */
describe('clearance authorization', () => {
  it.todo(
    'a member WITHOUT the required clearance cannot read a clearance-gated chat',
  );
  it.todo('a member WITH the required clearance can read a clearance-gated chat');
  it.todo(
    'holding the clearance without a membership row grants nothing — both axes are required',
  );
  it.todo('a chat with no required_clearance_id is readable by any member');
  it.todo('a higher clearance level satisfies a lower requirement');
  it.todo('a lower clearance level does not satisfy a higher requirement');
  it.todo('revoking a clearance removes access to the gated chat');
});

describe('group administration', () => {
  it.todo('a non-admin cannot add a member');
  it.todo('a non-admin cannot remove a member');
  it.todo('a non-admin cannot promote a member to admin');
  it.todo('an admin can approve a join request');
  it.todo('an admin cannot grant a clearance they do not themselves hold');
  it.todo('a DM has no admins and membership cannot be changed');
  it.todo('a group cannot drop below two members');
});
