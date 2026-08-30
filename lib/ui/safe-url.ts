/**
 * URL safety for rendered message content.
 *
 * Message text is attacker-controlled — by another user, or by a document the
 * agent read. The exfiltration channel this closes is the one that needs no
 * click: a resource the *page* loads on the reader's behalf. So message content
 * never produces an `<img>`, a stylesheet, or any auto-fetched resource.
 *
 * Links are different. A link the reader chooses to follow is their decision,
 * and a chat without links is annoying. But only `http:` and `https:` become
 * links — `javascript:`, `data:`, `vbscript:` and `file:` are rendered as inert
 * text instead.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/** Matches bare URLs in plain text. Split on this to interleave text and links. */
export const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;

/**
 * Returns a safe absolute URL string, or null when the input must not be made
 * clickable. Null means "render this as text".
 */
export function safeHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.toString();
}
