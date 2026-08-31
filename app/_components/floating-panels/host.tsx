'use client';

import { useFloatingPanels } from './context';
import { FloatingPanelWindow } from './window';

/**
 * Renders every open floating panel, plus a dock strip for minimized ones.
 *
 * Mounted once, at the authenticated layout, so panels persist across
 * client-side navigation between pages (the layout does not remount on route
 * changes within the App Router's nested-layout model).
 */
export function FloatingPanelHost() {
  const { panels, toggleMinimize } = useFloatingPanels();
  const minimized = panels.filter((p) => p.minimized);
  const open = panels.filter((p) => !p.minimized);

  if (panels.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {open.map((p) => (
        <FloatingPanelWindow key={p.chatId} panel={p} />
      ))}

      {minimized.length > 0 && (
        <div className="pointer-events-auto fixed bottom-3 right-3 flex flex-wrap justify-end gap-2">
          {minimized.map((p) => (
            <button
              key={p.chatId}
              onClick={() => toggleMinimize(p.chatId)}
              className="max-w-[10rem] truncate rounded-full border border-border bg-surface-raised px-3 py-1.5 text-xs shadow transition hover:border-border-strong"
              title={`Restore ${p.title}`}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
