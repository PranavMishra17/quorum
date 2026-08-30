/**
 * Deciding whether a model-authored URL may be fetched.
 *
 * The threat is server-side request forgery. The agent runs on our
 * infrastructure, so a fetch it performs originates from inside our network. A
 * URL that reaches the model — from a user, or from a document the model just
 * read — is a URL an attacker may have chosen.
 *
 * The classic target is a cloud metadata endpoint (169.254.169.254), which in a
 * misconfigured environment returns credentials to anything that asks. Private
 * ranges and localhost are the same class of problem: services that assume
 * anything able to reach them is already trusted.
 *
 * ---------------------------------------------------------------------------
 * HONEST LIMIT: this checks the hostname, not the resolved address.
 *
 * A hostname under attacker control can resolve to a private address, and can
 * resolve differently between this check and the actual connection — DNS
 * rebinding. Closing that properly means resolving first and pinning the
 * connection to the checked IP, which Node's fetch does not expose.
 *
 * What this does close: the direct cases, which is the overwhelming majority of
 * what a model will actually be tricked into. It should not be described as
 * SSRF-proof.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  // Cloud metadata. The single highest-value SSRF target there is.
  'metadata.google.internal', 'metadata.goog',
  'instance-data', 'metadata',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.onion'];

/** Literal IPv4 in a range that is not routable on the public internet. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[2]), Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;

  return (
    a === 0 ||                          // "this network"
    a === 10 ||                         // RFC1918
    a === 127 ||                        // loopback
    (a === 169 && b === 254) ||         // link-local — cloud metadata lives here
    (a === 172 && b >= 16 && b <= 31) ||  // RFC1918
    (a === 192 && b === 168) ||         // RFC1918
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224                            // multicast and reserved
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === '::1' || h === '::' ||
    h.startsWith('fc') || h.startsWith('fd') || // unique local
    h.startsWith('fe80') ||                     // link-local
    h.startsWith('::ffff:')                     // IPv4-mapped — smuggles the above
  );
}

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export function checkUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, gopher:, data: — all reach places a fetch should not.
    return { ok: false, reason: 'only http and https URLs may be fetched' };
  }

  const host = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: 'that host is not reachable from here' };
  }
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'that host is not reachable from here' };
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { ok: false, reason: 'that host is not reachable from here' };
  }
  // A bare hostname with no dot is almost always an internal service name.
  if (!host.includes('.') && !host.includes(':')) {
    return { ok: false, reason: 'that host is not reachable from here' };
  }

  // Credentials in a URL are a smuggling vector (user@evil.example) and have no
  // legitimate use here.
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not fetched' };
  }

  return { ok: true, url };
}
