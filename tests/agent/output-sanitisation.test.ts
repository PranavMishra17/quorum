import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { safeHttpUrl, URL_PATTERN } from '@/lib/ui/safe-url';

/**
 * Output sanitisation.
 *
 * Research R7 placed this in Phase 1 rather than with the tools, and the reason
 * is worth restating: the exfiltration channel here fires with **no agent and
 * no tool involved**. A message containing a remote image would beacon the
 * moment anyone opened the chat. Nobody has to click anything, and nobody has
 * to have enabled a tool.
 */

describe('link safety', () => {
  it('allows ordinary http and https links', () => {
    expect(safeHttpUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'about:blank',
  ])('refuses to linkify %s', (raw) => {
    expect(safeHttpUrl(raw)).toBeNull();
  });

  it('refuses anything that is not a URL at all', () => {
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl('//example.com')).toBeNull();
  });

  it('only matches http(s) when scanning text, so other schemes stay inert', () => {
    const line = 'see https://ok.example and javascript:alert(1) and data:text/html,x';
    const parts = line.split(URL_PATTERN);
    const matched = parts.filter((_, i) => i % 2 === 1);
    expect(matched).toEqual(['https://ok.example']);
  });

  it('does not swallow following prose into the link', () => {
    const parts = 'go to https://example.com now'.split(URL_PATTERN);
    expect(parts.filter((_, i) => i % 2 === 1)).toEqual(['https://example.com']);
    expect(parts.join('')).toBe('go to https://example.com now');
  });
});

/**
 * A codebase-wide assertion, not a unit test.
 *
 * The rule this defends is "no message content ever becomes markup or an
 * auto-fetched resource". That is a property of the whole app directory, and a
 * single component test cannot establish it — someone can always add a second
 * component.
 */
describe('the rendering layer never interprets content as markup', () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const files = [
    ...sourceFiles(join(process.cwd(), 'app')),
    ...sourceFiles(join(process.cwd(), 'lib')),
  ];

  /**
   * Scan CODE, not prose about code.
   *
   * The first version of this test failed on the comments explaining the rule —
   * a doc block naming `dangerouslySetInnerHTML` as the thing not to do is not
   * a use of it. Same lesson the boundary checker learned.
   */
  const code = (file: string) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('finds files to check — the scan has not silently stopped working', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('uses dangerouslySetInnerHTML nowhere', () => {
    const offenders = files.filter((f) => code(f).includes('dangerouslySetInnerHTML'));
    expect(offenders).toEqual([]);
  });

  it('renders no <img> tag in the message path', () => {
    // An <img> whose src comes from message content is the beacon. There is no
    // legitimate need for one anywhere in this app today, so the simplest
    // enforceable rule is: none at all.
    const offenders = files.filter((f) => /<img[\s>]/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('every external link carries noopener and noreferrer', () => {
    for (const f of files) {
      const source = readFileSync(f, 'utf8');
      for (const m of source.matchAll(/target=["{']_blank/g)) {
        const window = source.slice(Math.max(0, m.index - 300), m.index + 300);
        expect(window, `${f} has target=_blank without rel`).toMatch(/noopener/);
        expect(window, `${f} has target=_blank without noreferrer`).toMatch(/noreferrer/);
      }
    }
  });
});
