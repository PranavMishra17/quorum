/**
 * The clearance stamp and the redaction bar — the two primitives the whole
 * visual system is built from.
 *
 * Both are pure and server-renderable. Neither takes a `className` escape
 * hatch, on purpose: a stamp that can be restyled at the call site stops being
 * a stamp, and the entire value of "colour means clearance" comes from it
 * looking identical everywhere it appears.
 */

/** Ladder levels, matching `config/agent.ts` CLEARANCES. */
export type ClearanceLevel = 0 | 1 | 2 | 3;

const SCALE: Record<ClearanceLevel, { token: string; short: string }> = {
  0: { token: 'var(--c0)', short: 'GEN' },
  1: { token: 'var(--c1)', short: 'INT' },
  2: { token: 'var(--c2)', short: 'CONF' },
  3: { token: 'var(--c3)', short: 'RESTR' },
};

export function clearanceToken(level: number): string {
  return SCALE[(Math.min(3, Math.max(0, Math.round(level))) as ClearanceLevel)].token;
}

/**
 * A clearance stamp.
 *
 * Rendered as a hairline-boxed label in the rung's own colour rather than a
 * filled pill, because a filled pill reads as a status chip — something that
 * happened — and this is a property of the thing it sits on. The box is the
 * cheapest way to say "stamped on" rather than "attached to".
 */
export function ClearanceStamp({
  level,
  name,
  size = 'sm',
}: {
  level: number;
  name?: string;
  /** `sm` for tiles, `md` for page headers. */
  size?: 'sm' | 'md';
}) {
  const rung = SCALE[(Math.min(3, Math.max(0, Math.round(level))) as ClearanceLevel)];
  const text = name ?? rung.short;

  return (
    <span
      className={`label inline-block shrink-0 border ${
        size === 'md' ? 'px-2 py-1' : 'px-1.5 py-0.5'
      }`}
      style={{ color: rung.token, borderColor: rung.token }}
      title={`Clearance: ${text}`}
    >
      {text}
    </span>
  );
}

/**
 * A redaction bar.
 *
 * ---------------------------------------------------------------------------
 * IT RENDERS NO CHILDREN, AND THAT IS THE POINT
 *
 * This component takes a WIDTH, not content. There is deliberately no way to
 * pass it something to hide, because every mechanism for hiding text in CSS —
 * `color: transparent`, `visibility: hidden`, a zero-height clip — still ships
 * the text to view-source, to the clipboard, and to a screen reader. For a
 * product whose entire claim is that unauthorised content never reaches the
 * client, a redaction you could select and copy would be the most embarrassing
 * possible bug.
 *
 * So the server never sends the content, and this draws the hole it left. The
 * bar is sized to the shape of what is missing so a reader can see there WAS
 * something, which is exactly the disclosure D-027 permits: you may learn that
 * a thing exists, and nothing more.
 */
export function Redacted({
  width = '100%',
  label = 'Redacted — you are not cleared for this',
}: {
  /** Any CSS length. Vary it across a list so it reads as content, not as bars. */
  width?: string;
  label?: string;
}) {
  return (
    <span
      className="redacted inline-block h-[0.95em] align-middle"
      style={{ width }}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

/**
 * Several redaction bars standing in for a line of text.
 *
 * Widths are derived from a seed rather than random so the server and client
 * render the same thing — a hydration mismatch on the one element that means
 * "there is something here you cannot see" would be a poor place for React to
 * warn about mismatched HTML.
 */
export function RedactedLines({ seed, lines = 2 }: { seed: string; lines?: number }) {
  return (
    <span className="flex flex-col gap-1">
      {Array.from({ length: lines }, (_, i) => (
        <Redacted key={i} width={`${barWidth(seed, i)}%`} />
      ))}
    </span>
  );
}

/** Pure: the same seed and index always give the same width, on both renders. */
function barWidth(seed: string, index: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  h = Math.imul(h ^ index, 16777619) >>> 0;
  return 45 + ((h >>> 8) % 50); // 45-94%
}
