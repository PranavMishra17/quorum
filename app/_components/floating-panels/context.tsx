'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Floating chat panels — multiple conversations open at once, as movable
 * overlay windows on top of whatever page you're on.
 *
 * This is deliberately the LAST thing built (D-017's ordering: list UI first,
 * anything spatial last) and is scoped accordingly: state lives here and in
 * `sessionStorage`, not in a database table. Closing the tab loses your open
 * panels; that is an acceptable cost for a feature that exists to make
 * multi-chat browsing convenient, not to be a durable workspace layout.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT CHANGE
 *
 * A panel is a `ChatSurface` in a box. It sends through the same
 * `/api/chats/:id/messages` route, subscribes to the same Realtime channels,
 * and is scoped by the same RLS as the full-page chat. Opening a floating panel
 * for a chat you cannot access gets you the same empty state the full page
 * gives you — there is no separate, weaker path in here.
 */

export interface PanelState {
  chatId: string;
  /** Cached at open time so the header has a title before the panel's own
   *  client-side fetch resolves the chat's real name. */
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
}

interface Ctx {
  panels: PanelState[];
  open: (chatId: string, title: string) => void;
  close: (chatId: string) => void;
  focus: (chatId: string) => void;
  toggleMinimize: (chatId: string) => void;
  update: (chatId: string, patch: Partial<Pick<PanelState, 'x' | 'y' | 'w' | 'h'>>) => void;
}

const FloatingPanelsContext = createContext<Ctx | null>(null);

export function useFloatingPanels(): Ctx {
  const ctx = useContext(FloatingPanelsContext);
  if (!ctx) throw new Error('useFloatingPanels must be used within FloatingPanelsProvider');
  return ctx;
}

const STORAGE_KEY = 'quorum:floating-panels:v1';
/**
 * Each open panel holds its own Realtime subscriptions (messages, membership
 * revocation, per-turn traces). A soft cap keeps that bounded rather than
 * growing with however many chats someone middle-clicks in a session.
 */
const MAX_PANELS = 4;
const DEFAULT_SIZE = { w: 360, h: 460 };

export function FloatingPanelsProvider({ children }: { children: React.ReactNode }) {
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Read once on mount, deliberately in an effect rather than useState's
  // initializer. The initializer would run during SSR too, where
  // `sessionStorage` does not exist — and it must also run identically on the
  // client's FIRST render for hydration to match the server-rendered markup.
  // Reading storage there and returning something different from the SSR pass
  // (empty) is exactly the hydration mismatch this avoids: render empty on
  // both passes, then adopt what storage holds one tick later.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see note above: this IS the hydration-safe read, not a pattern to refactor away.
      if (raw) setPanels(JSON.parse(raw) as PanelState[]);
    } catch {
      // A corrupt or absent entry is an empty set, not an error.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return; // don't overwrite storage with [] before the read above lands
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(panels));
    } catch {
      // Storage can be full or disabled (private browsing). Panels still work
      // for the session; they just won't survive a reload.
    }
  }, [panels, hydrated]);

  const topZ = useCallback(
    (list: PanelState[]) => list.reduce((max, p) => Math.max(max, p.z), 0),
    [],
  );

  const open = useCallback((chatId: string, title: string) => {
    setPanels((cur) => {
      const existing = cur.find((p) => p.chatId === chatId);
      if (existing) {
        return cur.map((p) =>
          p.chatId === chatId ? { ...p, minimized: false, z: topZ(cur) + 1 } : p,
        );
      }

      const cascade = cur.length % 5;
      const fresh: PanelState = {
        chatId,
        title,
        x: 40 + cascade * 32,
        y: 72 + cascade * 32,
        ...DEFAULT_SIZE,
        z: topZ(cur) + 1,
        minimized: false,
      };

      if (cur.length < MAX_PANELS) return [...cur, fresh];

      // At the cap: replace the least-recently-focused panel rather than
      // silently refusing the request, which would read as a bug.
      const lru = [...cur].sort((a, b) => a.z - b.z)[0];
      return cur.map((p) => (p.chatId === lru.chatId ? fresh : p));
    });
  }, [topZ]);

  const close = useCallback((chatId: string) => {
    setPanels((cur) => cur.filter((p) => p.chatId !== chatId));
  }, []);

  const focus = useCallback((chatId: string) => {
    setPanels((cur) => {
      const z = topZ(cur) + 1;
      return cur.map((p) => (p.chatId === chatId ? { ...p, z } : p));
    });
  }, [topZ]);

  const toggleMinimize = useCallback((chatId: string) => {
    setPanels((cur) => {
      const z = topZ(cur) + 1;
      return cur.map((p) =>
        p.chatId === chatId ? { ...p, minimized: !p.minimized, z } : p,
      );
    });
  }, [topZ]);

  const update = useCallback(
    (chatId: string, patch: Partial<Pick<PanelState, 'x' | 'y' | 'w' | 'h'>>) => {
      setPanels((cur) => cur.map((p) => (p.chatId === chatId ? { ...p, ...patch } : p)));
    },
    [],
  );

  const value = useMemo<Ctx>(
    () => ({ panels, open, close, focus, toggleMinimize, update }),
    [panels, open, close, focus, toggleMinimize, update],
  );

  return (
    <FloatingPanelsContext.Provider value={value}>
      {children}
    </FloatingPanelsContext.Provider>
  );
}
