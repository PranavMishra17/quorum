'use client';

import { useFloatingPanels } from './context';

/**
 * The one affordance that opens a floating panel. Used on the chat list (open
 * a chat without leaving the list) and on the full chat page's header (keep
 * this chat afloat while navigating elsewhere).
 *
 * Deliberately `stopPropagation` where it sits inside a `<Link>` on the chat
 * list — clicking it must pop the panel open, not also navigate to the full
 * page underneath it.
 */
export function PopOutButton({
  chatId,
  title,
  className = '',
}: {
  chatId: string;
  title: string;
  className?: string;
}) {
  const { open } = useFloatingPanels();

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(chatId, title);
      }}
      title={`Open "${title}" in a floating panel`}
      className={`px-1.5 py-0.5 text-xs text-muted transition hover:bg-surface-raised hover:text-foreground ${className}`}
    >
      ⇱
    </button>
  );
}
