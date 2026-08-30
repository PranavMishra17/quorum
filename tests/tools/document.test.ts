import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { documentExtract, containsQuote } from '@/lib/agent/tools/document';
import { fileRead, fileList } from '@/lib/agent/tools/file';
import { toolDefinition } from '@/lib/agent/tools';
import { DOCUMENTS } from '@/config';
import type { AnyTool } from '@/lib/agent/tools/types';

/**
 * `document_extract` — structured extraction, and the checks around it.
 *
 * The model call itself is not exercised here (it costs money and proves the
 * model's behaviour, not ours). What IS exercised is everything that decides
 * whether the model's answer can be believed: the quote verification, the input
 * bounds, and the two declared flags that the whole tool boundary rests on.
 */

describe('the flags this tool declares', () => {
  /**
   * If this were `externallyObservable: true`, D-022 would block it after the
   * first file_read — which is the only situation it is ever used in. The tool
   * would appear to exist and never once run.
   */
  it('is NOT externally observable: the document already goes to the model provider', () => {
    expect(documentExtract.externallyObservable).toBe(false);
  });

  it('DOES return untrusted content: the values are derived from the document', () => {
    expect(documentExtract.returnsUntrustedContent).toBe(true);
  });

  it('agrees with file_read, which reads the same bytes', () => {
    expect(fileRead.returnsUntrustedContent).toBe(true);
    expect(fileRead.externallyObservable).toBe(false);
    // Metadata we generated ourselves is the one thing here that is trusted.
    expect(fileList.returnsUntrustedContent).toBe(false);
  });
});

describe('quote verification — a citation nobody checks is decoration', () => {
  const doc =
    'This Master Services Agreement is entered into between Acme Ltd and Beta GmbH\n' +
    'on 1 March 2026, and shall be governed by the laws of England and Wales.';

  it('accepts a genuine verbatim quote', () => {
    expect(containsQuote(doc, 'governed by the laws of England and Wales')).toBe(true);
  });

  it('accepts a real quote whose whitespace was reflowed by the extractor', () => {
    // PDF extraction reflows lines. An exact byte match would reject quotes
    // that ARE real and push the honest answer into the unverified bucket.
    expect(containsQuote(doc, 'between Acme   Ltd\n and Beta GmbH')).toBe(true);
  });

  it('REJECTS a plausible quote the document does not contain', () => {
    // The dangerous case: fabricated text carries the visual grammar of
    // evidence, so it is more convincing than a fabricated bare value.
    expect(containsQuote(doc, 'governed by the laws of the State of Delaware')).toBe(false);
  });

  it('rejects a paraphrase of something the document does say', () => {
    expect(containsQuote(doc, 'shall be governed by English law')).toBe(false);
  });

  it('refuses to treat a very short span as evidence', () => {
    // 'Acme Ltd' is in the document, but a two-word match is coincidence, not
    // support — and a model that returns one is reaching.
    expect(containsQuote(doc, 'Acme Ltd')).toBe(false);
  });

  it('does not case-fold, because looser matching accepts absent quotes', () => {
    expect(containsQuote(doc, 'GOVERNED BY THE LAWS OF ENGLAND')).toBe(false);
  });
});

describe('input bounds — field names are model-authored, so they are input', () => {
  const parse = (v: unknown) => documentExtract.inputSchema.safeParse(v);
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('accepts a sensible request', () => {
    expect(parse({ fileId: uuid, fields: ['parties', 'governing law'] }).success).toBe(true);
  });

  it('refuses a file id that is not a uuid', () => {
    expect(parse({ fileId: 'not-a-uuid', fields: ['parties'] }).success).toBe(false);
  });

  it('refuses an empty field list rather than asking the model to invent one', () => {
    expect(parse({ fileId: uuid, fields: [] }).success).toBe(false);
  });

  it('caps the field count at the configured maximum', () => {
    const many = Array.from({ length: DOCUMENTS.maxSchemaFields + 1 }, (_, i) => `field ${i}`);
    expect(parse({ fileId: uuid, fields: many }).success).toBe(false);
  });

  it('refuses unknown keys, so a crafted input cannot smuggle one past', () => {
    expect(parse({ fileId: uuid, fields: ['parties'], chatId: 'other' }).success).toBe(false);
  });
});

/**
 * The wire schema handed to the model.
 *
 * This is the regression that motivated replacing the hand-rolled converter:
 * it described every property as a string, so `fields` — an array — was
 * advertised as a string. The model would send one and have it rejected by the
 * very schema that had just described it, and the symptom is a model that
 * merely *appears* not to use the tool well.
 */
describe('tool definitions sent to the model', () => {
  it('describes an array input as an array, not as a string', () => {
    const def = toolDefinition(documentExtract as unknown as AnyTool);
    const props = def.input_schema.properties as Record<string, { type: string }>;

    expect(props.fields.type).toBe('array');
    expect(props.fileId.type).toBe('string');
  });

  it('carries the descriptions the model needs to use the tool', () => {
    const def = toolDefinition(documentExtract as unknown as AnyTool);
    const props = def.input_schema.properties as Record<string, { description?: string }>;
    expect(props.fields.description).toMatch(/governing law/);
  });

  it('marks both inputs required and forbids extra properties', () => {
    const def = toolDefinition(documentExtract as unknown as AnyTool);
    expect(def.input_schema.required).toEqual(expect.arrayContaining(['fileId', 'fields']));
    expect(def.input_schema.additionalProperties).toBe(false);
  });

  it('omits $schema, which the Anthropic API rejects', () => {
    const def = toolDefinition(documentExtract as unknown as AnyTool);
    expect(def.input_schema).not.toHaveProperty('$schema');
  });

  it('still handles a tool with no inputs at all', () => {
    const def = toolDefinition(fileList as unknown as AnyTool);
    expect(def.input_schema.type).toBe('object');
    expect(def.input_schema.properties).toEqual({});
  });

  it('throws on a schema it cannot represent, rather than sending the model {}', () => {
    const broken = {
      name: 'broken',
      description: 'x',
      inputSchema: z.object({ when: z.date() }),
    } as unknown as AnyTool;
    expect(() => toolDefinition(broken)).toThrow();
  });
});
