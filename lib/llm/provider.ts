import type { CallPurpose } from '@/config';

/**
 * The model provider seam.
 *
 * Callers name a PURPOSE, never a model. Purpose → tier → model + effort +
 * limits, all resolved in `config/models.ts`. That indirection is why a dead or
 * rate-limited key is a one-file change rather than a grep across the codebase,
 * which matters here because the supplied key is short-lived by design.
 *
 * Adding a provider, a model, or a fallback chain must not require touching
 * anything outside `lib/llm/`.
 */

export interface ProviderMessage {
  role: 'user' | 'assistant';
  /** A string, or raw content blocks when replaying a tool exchange. */
  content: string | unknown[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A tool call the model asked for. Never executed by this layer. */
export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface CompleteParams {
  purpose: CallPurpose;
  system?: string;
  messages: ProviderMessage[];
  /**
   * Tools to offer. The provider passes them through and reports back what the
   * model asked for; it never executes anything. Execution belongs to
   * ToolSession, which owns the bounds and the authorisation.
   */
  tools?: ToolDefinition[];
  /** Cancels the call. The orchestrator's wall clock lives here. */
  signal?: AbortSignal;
}

export interface StructuredParams<T> extends CompleteParams {
  /** JSON Schema the response must satisfy. */
  schema: object;
  /** Runtime validation. A schema-valid but semantically wrong answer is still
   *  wrong, so the caller supplies the check rather than trusting the shape. */
  validate: (value: unknown) => value is T;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  model: string;
  stopReason: string | null;
  /** Tool calls the model requested, if any. */
  toolUses?: ToolUse[];
  /** Raw assistant content, needed verbatim when continuing a tool exchange. */
  raw?: unknown[];
}

export interface StructuredResult<T> extends CompleteResult {
  value: T;
}

export interface LlmProvider {
  /** Free-form text. Used for the agent's actual reply. */
  complete(params: CompleteParams): Promise<CompleteResult>;

  /**
   * A response constrained to a schema AND validated at runtime.
   * Used wherever the answer feeds a branch — the gate verdict, extraction.
   */
  structured<T>(params: StructuredParams<T>): Promise<StructuredResult<T>>;
}
