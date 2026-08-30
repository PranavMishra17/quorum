import { DOCUMENTS } from '@/config';

/**
 * Turn an uploaded document into text.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE PARSES ATTACKER-CONTROLLED BYTES
 *
 * Everything that reaches `extractDocumentText` was chosen by whoever uploaded
 * it, which for a legal product very often means someone outside the workspace
 * who emailed a contract in. Two consequences, and neither is theoretical:
 *
 * 1. **The parser is the attack surface, not the text.** A PDF is a small
 *    programming language and `pdf.js` is a large interpreter for it. We do not
 *    get to assume it cannot be made to misbehave, so the bounds below are
 *    applied around it rather than trusted from inside it.
 *
 * 2. **The text is an injection vector.** It comes back through `file_read`,
 *    which declares `returnsUntrustedContent: true` — so it is fenced with
 *    provenance, the D-022 trapdoor closes for the rest of the turn, and
 *    anything extracted into memory from that turn is forced to
 *    `inferred` + `candidate` (T10). None of that is this module's job; it is
 *    inherited, which is the point of the tool interface.
 *
 * The bounds here are the ones a parsing library will not apply for you:
 *
 * | Bound | Why |
 * |---|---|
 * | Input size | applied at upload (`MAX_BYTES`) and again at read |
 * | Output chars | a 200 KB `.docx` of one repeated glyph decompresses to megabytes; the ZIP does not have to be malicious to be pathological |
 * | Page count | a PDF's page count is cheap to inflate and expensive to render |
 *
 * **What is NOT bounded, honestly:** CPU. A `Promise.race` against a timer does
 * not stop synchronous work inside a parser — it only stops *waiting* for it,
 * while the event loop stays blocked. Pretending otherwise would be a comment
 * that describes a control which does not exist. The real mitigations are the
 * input cap and the fact that extraction runs inside a request that Vercel will
 * itself terminate. A production version puts this in its own worker.
 */

export type ExtractionKind = 'text' | 'html' | 'pdf' | 'docx';

export type Extraction =
  | {
      ok: true;
      kind: ExtractionKind;
      text: string;
      truncated: boolean;
      /** Present for paginated formats. */
      pages?: number;
      /** Pages actually read, when fewer than `pages`. */
      pagesRead?: number;
      /** Non-fatal notes worth showing the model, e.g. "no text layer". */
      note?: string;
    }
  | { ok: false; reason: string };

/** Plain-text-ish types we can decode without a parser. */
export const TEXT_MIMES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml',
]);

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Everything the agent can read as text. The upload allowlist mirrors this. */
export function isExtractable(mime: string): boolean {
  return TEXT_MIMES.has(mime) || mime === PDF_MIME || mime === DOCX_MIME;
}

/**
 * Extract text from a document.
 *
 * Never throws for bad input: a corrupt file is an ordinary state, not an
 * exception, and a thrown error inside a tool becomes "the tool failed" — which
 * tells the model nothing it can act on. A structured refusal lets it say
 * "that PDF is password-protected" instead.
 */
export async function extractDocumentText(
  bytes: ArrayBuffer,
  mime: string,
  maxChars: number = DOCUMENTS.maxExtractedChars,
): Promise<Extraction> {
  if (bytes.byteLength === 0) return { ok: false, reason: 'the file is empty' };

  if (TEXT_MIMES.has(mime)) {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const text = mime === 'text/html' ? stripHtml(raw) : raw;
    const { content, truncated } = truncate(text, maxChars);
    return { ok: true, kind: mime === 'text/html' ? 'html' : 'text', text: content, truncated };
  }

  if (mime === PDF_MIME) return extractPdf(bytes, maxChars);
  if (mime === DOCX_MIME) return extractDocx(bytes, maxChars);

  return { ok: false, reason: `${mime} cannot be read as text` };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * `unpdf` rather than `pdf-parse`.
 *
 * `pdf-parse` is a thin wrapper around a pinned, years-old `pdf.js` build and
 * famously executes a debug file-read at import time when called without
 * arguments. `unpdf` ships a serverless-targeted `pdf.js` with no native
 * dependency, which matters because this runs on Vercel where `@napi-rs/canvas`
 * would not.
 *
 * Pages are extracted unmerged so the page cap can be applied *while* reading
 * rather than by truncating a merged string — the difference between "we read
 * 20 of 900 pages" and "we read 900 pages and threw most of it away".
 */
async function extractPdf(bytes: ArrayBuffer, maxChars: number): Promise<Extraction> {
  let totalPages: number;
  let pageTexts: string[];

  try {
    const { extractText } = await import('unpdf');
    const result = await extractText(new Uint8Array(bytes), { mergePages: false });
    totalPages = result.totalPages;
    pageTexts = result.text;
  } catch (err) {
    return { ok: false, reason: describePdfFailure(err) };
  }

  const limit = Math.min(pageTexts.length, DOCUMENTS.maxPdfPages);
  const joined = pageTexts
    .slice(0, limit)
    .map((page, i) => `[page ${i + 1}]\n${page.trim()}`)
    .join('\n\n')
    .trim();

  // A scanned contract is a stack of images. Returning '' would read to the
  // model as "this document is blank", which is a materially wrong answer to
  // give about a legal document — so say what actually happened.
  const hasText = joined.replace(/\[page \d+\]/g, '').trim().length > 0;
  if (!hasText) {
    return {
      ok: false,
      reason:
        `this PDF has no extractable text layer across ${limit} page(s) — ` +
        `it is most likely a scan, and reading it would need OCR, which is not available`,
    };
  }

  const { content, truncated } = truncate(joined, maxChars);
  return {
    ok: true,
    kind: 'pdf',
    text: content,
    truncated,
    pages: totalPages,
    pagesRead: limit,
    note:
      limit < totalPages
        ? `only the first ${limit} of ${totalPages} pages were read`
        : undefined,
  };
}

/** Turn a parser exception into something a human — and the model — can act on. */
function describePdfFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/password/i.test(message)) {
    return 'this PDF is password-protected and cannot be read';
  }
  if (/invalid pdf|structure/i.test(message)) {
    return 'this PDF appears to be corrupt and could not be parsed';
  }
  return 'this PDF could not be parsed';
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/**
 * `mammoth` rather than a hand-rolled ZIP reader.
 *
 * Writing 60 lines of `inflateRaw` over a central directory is tempting — no
 * dependency, full control of the bounds. It is also writing a new parser for
 * hostile bytes, which is the opposite of what "fewer dependencies" is meant to
 * buy. A well-exercised library plus an output cap is the better trade.
 *
 * `extractRawText` deliberately, not `convertToHtml`: HTML would then be
 * flattened by `stripHtml` anyway, and the intermediate step is one more place
 * for markup to survive into the prompt.
 */
async function extractDocx(bytes: ArrayBuffer, maxChars: number): Promise<Extraction> {
  try {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = value.trim();

    if (text.length === 0) {
      return { ok: false, reason: 'this document contains no text' };
    }

    const { content, truncated } = truncate(text, maxChars);
    return { ok: true, kind: 'docx', text: content, truncated };
  } catch {
    return {
      ok: false,
      reason: 'this .docx could not be parsed — it may be corrupt, or an older .doc file',
    };
  }
}

// ---------------------------------------------------------------------------
// Shared text handling
// ---------------------------------------------------------------------------

/**
 * Crude HTML-to-text. Script and style bodies go first, because their contents
 * are not prose and a `<script>` block full of URLs is exactly the sort of thing
 * that reads as an instruction once flattened.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncate on a character budget, cutting at a line break where possible. */
export function truncate(
  text: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return {
    content: lastBreak > maxChars * 0.8 ? cut.slice(0, lastBreak) : cut,
    truncated: true,
  };
}
