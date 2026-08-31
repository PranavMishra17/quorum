import { NextResponse } from 'next/server';
import { requireActor, NotAuthenticatedError } from '@/lib/db/server';
import { resetDemoWorld } from '@/lib/demo/seed';

/**
 * "Reset demo" — delete the caller's demo rooms and rebuild them fresh.
 *
 * `resetDemoWorld()` calls `reset_demo_world()`, which takes no id and only
 * ever touches chats where the CALLER is a member and `is_demo = true`
 * (migration 0020). There is no argument this route could be tricked into
 * passing that would widen that — the only input is who is signed in.
 */
export async function POST() {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    }
    throw err;
  }

  try {
    await resetDemoWorld();
  } catch {
    return NextResponse.json({ error: 'could not reset the demo world' }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
