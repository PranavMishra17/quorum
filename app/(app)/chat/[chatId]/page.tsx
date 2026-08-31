import { redirect } from 'next/navigation';

/**
 * The single-chat page was folded into Rooms (`/people`), which already shows
 * every conversation you're in with the roster and internal view alongside it.
 * Anything that used to link here — pop-out "open as a page", the account
 * page's group list — now lands in that same view with the room pre-selected.
 *
 * No membership check: `/people?open=` re-resolves the room from the caller's
 * own memberships, so an old link to a room you've left just opens whatever
 * Rooms shows for you instead of leaking whether the id ever existed.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId } = await params;
  redirect(`/people?open=${chatId}`);
}
