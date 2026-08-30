import type { ZodType } from 'zod';
import type { ScopedAgentContext } from '@/lib/db/scoped-agent';

/**
 * The tool interface.
 *
 * Two flags carry the security weight, and both are declared by the tool rather
 * than inferred by the runtime — because getting either wrong is a leak, and a
 * declaration is reviewable in a way that inference is not.
 */

export interface Citation {
  /** Stable identifier: a file id, or a URL. */
  ref: string;
  /** Human label for rendering. */
  label: string;
  /** Where the claim came from within the source, if known. */
  locator?: string;
}

export interface ToolResult {
  /** What the model sees. Fenced before it reaches the prompt if untrusted. */
  content: string;
  /**
   * Sources the agent may attribute to. The point is not decoration: a fact
   * that came from a fetched page is a *claim by that page*, and presenting it
   * as the agent's own knowledge is how injected content becomes authoritative.
   */
  citations: Citation[];
  /** Surfaced in the internal view. Never shown to the model. */
  meta?: Record<string, unknown>;
}

export interface Tool<I> {
  name: string;
  /** Shown to the model. Describes what it does, not how to use it. */
  description: string;
  /** Validated BEFORE execution. Tool input is model-authored, so it is input. */
  inputSchema: ZodType<I>;

  /**
   * Does invoking this make a request an outside observer could see?
   *
   * This is the exfiltration axis. A web fetch is observable — the URL and its
   * timing leak to whoever controls that host, and the URL is model-authored,
   * so it can carry data. Reading a file from our own storage is not.
   *
   * D-022 uses this: once a turn has ingested untrusted content, no further
   * externally-observable tool may run. That is the structural control; the
   * fence below is only defence in depth.
   */
  externallyObservable: boolean;

  /**
   * Is the content this returns attacker-influenceable?
   *
   * True for anything whose bytes someone outside the trust boundary chose —
   * a fetched page, an uploaded document. False for data we generated.
   *
   * Marking this true has two consequences, both automatic: the content is
   * fenced with provenance before the model sees it, and the turn is downgraded
   * so that memory extracted from it lands as `candidate` (T10).
   */
  returnsUntrustedContent: boolean;

  /**
   * Execute.
   *
   * Note the signature: the ONLY way to reach data is through `ctx`, which is
   * scoped to one chat and re-checks authorisation on every privileged read. A
   * tool cannot widen its own scope, because no context method accepts a
   * scope-defining id — that invariant is what makes this capability-style
   * rather than ambient authority with extra steps.
   */
  execute(input: I, ctx: ScopedAgentContext): Promise<ToolResult>;
}

/** Erased form, for storing tools of differing input types in one registry. */
export type AnyTool = Tool<never> & {
  inputSchema: ZodType<unknown>;
  execute(input: never, ctx: ScopedAgentContext): Promise<ToolResult>;
};
