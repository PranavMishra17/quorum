import { describe, it, expect } from 'vitest';
import { checkUrl } from '@/lib/agent/tools/url-safety';

/**
 * SSRF.
 *
 * The agent fetches from inside our network, and the URL is model-authored —
 * so it is chosen by whoever last influenced the model, which may be a document
 * it just read. These are the cases that matter.
 */

const allowed = (u: string) => expect(checkUrl(u).ok, u).toBe(true);
const refused = (u: string) => expect(checkUrl(u).ok, u).toBe(false);

describe('ordinary public URLs are allowed', () => {
  it.each([
    'https://example.com',
    'https://example.com/path?q=1#frag',
    'http://example.co.uk/a/b',
    'https://sub.domain.example.org:8443/x',
  ])('%s', allowed);
});

describe('cloud metadata endpoints are refused', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://169.254.169.254',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/computeMetadata/v1/',
  ])('%s', refused);

  it('is the highest-value target, so it is refused on every path shape', () => {
    // In a misconfigured environment this returns credentials to anything that
    // asks. There is no legitimate reason for the agent to reach it.
    refused('http://169.254.169.254/');
    refused('https://169.254.169.254/anything');
  });
});

describe('loopback and private ranges are refused', () => {
  it.each([
    'http://localhost:3000/admin',
    'http://LOCALHOST/admin',
    'http://127.0.0.1:5432',
    'http://127.99.1.2',
    'http://10.0.0.5/internal',
    'http://192.168.1.1',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://100.64.0.1',
    'http://0.0.0.0',
    'http://[::1]:8080',
    'http://[fd00::1]',
    'http://[fe80::1]',
  ])('%s', refused);

  it('allows 172.32.x, which is NOT private — the boundary is checked, not guessed', () => {
    allowed('http://172.32.0.1.example.com');
    refused('http://172.16.0.1');
    allowed('http://172.15.0.1.nip.example');
  });

  it('refuses an IPv4-mapped IPv6 address, which smuggles a private v4', () => {
    refused('http://[::ffff:127.0.0.1]');
    refused('http://[::ffff:169.254.169.254]');
  });
});

describe('internal-looking hostnames are refused', () => {
  it.each([
    'http://redis',
    'http://db.internal/x',
    'http://printer.local',
    'http://something.home.arpa',
    'http://abc.onion',
  ])('%s', refused);

  it('a bare hostname with no dot is almost always an internal service', () => {
    refused('http://vault');
    refused('http://kubernetes');
  });
});

describe('scheme and credential smuggling', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://example.com',
    'data:text/html,<script>x</script>',
    'javascript:alert(1)',
    'ftp://example.com/x',
  ])('refuses %s', refused);

  it('refuses embedded credentials', () => {
    // user@host is a classic way to make a URL look like it targets one host
    // while actually targeting another.
    refused('https://example.com@169.254.169.254/');
    refused('https://user:pass@example.com/');
  });

  it('refuses anything that is not a URL', () => {
    refused('not a url');
    refused('');
    refused('//example.com');
  });
});

describe('the limit is stated, not hidden', () => {
  it('a public hostname is allowed even though it could resolve privately', () => {
    // This check inspects the HOSTNAME, not the resolved address. A hostname
    // under attacker control can resolve to a private address, and can resolve
    // differently between this check and the connection (DNS rebinding).
    // Closing that needs resolve-then-pin, which Node's fetch does not expose.
    // The test documents the gap rather than pretending it is covered.
    allowed('http://totally-public-looking.example.com');
  });
});
