import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { clientEnv, serverEnv } from '@/config';
import type { FileRow, Message } from './types';

/**
 * THE ONLY FILE PERMITTED TO READ THE SERVICE-ROLE KEY.
 *
 * Enforced mechanically by `pnpm check:boundaries`, which fails the build if
 * `SUPABASE_SECRET_KEY` appears anywhere else. That is not a security boundary —
 * a lint rule never is — it is the earliest point at which the mistake can be
 * caught. RLS is the boundary.
 *
 * ---------------------------------------------------------------------------
 * Why this class exists
 *
 * The agent runs server-side and must read across chats to work, which makes it
 * the single most likely path to a leak. So it never holds an unscoped
 * service-role client in the request path. Every read it performs goes through
 * a context constructed for ONE chat, which applies both authorisation axes in
 * SQL before returning anything.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT — this is what makes the design capability-style
 *
 *   **No method on this class accepts a scope-defining id as a parameter.**
 *
 * No `chatId`, no other user's id. Scope comes from construction and nowhere
 * else. This matters because tool input is transitively model-controlled and
 * therefore injection-influenceable: a method taking a `chat_id` from tool
 * input would let a crafted document redirect the agent's reads, and the
 * context would have degraded into ambient authority with extra steps.
 *
 * Asserted by `tests/agent/scoped-context-invariant.test.ts`. If you add a
 * method that takes an id, that test fails, and it is right.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO — it does not cache membership
 *
 * The context fixes turn IDENTITY (chat, actor, turn, request) at construction.
 * It does NOT hold the member set or the clearance level. Those are re-read, in
 * SQL, on every privileged call.
 *
 * Holding them across a multi-second model call IS the time-of-check /
 * time-of-use gap (D-009). An earlier draft of the README said this class
 * "resolves and holds" them, which would have instructed an implementer to
 * build the exact bug the project claims not to have. Re-reading costs
 * essentially nothing, because every PostgREST call is already its own
 * transaction. Do not "optimise" this into a cache.
 */
export class ScopedAgentContext {
  private constructor(
    private readonly db: SupabaseClient,
    /** The chat this turn is scoped to. Fixed at construction, never a parameter. */
    readonly chatId: string,
    /** The human whose message started this turn. */
    readonly actorId: string,
    /** Correlates every agent_events and llm_calls row for this turn. */
    readonly turnId: string,
    /** This delivery attempt. A retry resumes turnId under a new requestId. */
    readonly requestId: string,
  ) {}

  /**
   * Open a context for one turn.
   *
   * Fails closed: if the actor cannot access the chat on BOTH axes right now,
   * no context exists and the turn cannot start.
   */
  static async open(params: {
    chatId: string;
    actorId: string;
    turnId: string;
    requestId: string;
  }): Promise<ScopedAgentContext> {
    const db = createServiceClient();
    const ctx = new ScopedAgentContext(
      db,
      params.chatId,
      params.actorId,
      params.turnId,
      params.requestId,
    );
    await ctx.assertActorAuthorised();
    return ctx;
  }

  // -------------------------------------------------------------------------
  // Authorisation state — re-read every time, never cached
  // -------------------------------------------------------------------------

  /** Active members of this chat, as of right now. */
  async activeMemberIds(): Promise<string[]> {
    const { data, error } = await this.db
      .from('chat_members')
      .select('user_id')
      .eq('chat_id', this.chatId)
      .eq('status', 'member');
    if (error) throw error;
    return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  }

  /** This chat's clearance floor. 0 when ungated. */
  async clearanceLevel(): Promise<number> {
    const { data, error } = await this.db
      .from('chats')
      .select('required_clearance_id, clearances:required_clearance_id(level)')
      .eq('id', this.chatId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { clearances?: { level: number } | null } | null;
    const clearance = row?.clearances;
    return clearance?.level ?? 0;
  }

  /**
   * Re-verify that the actor still passes both axes.
   *
   * Call this before any privileged read whose result reaches the model. A
   * removal landing mid-turn takes effect at the next such call — which is the
   * guarantee the README publishes, and it is stronger than "the next turn".
   */
  async assertActorAuthorised(): Promise<void> {
    const { data, error } = await this.db.rpc('can_access_chat_for', {
      p_chat_id: this.chatId,
      p_user_id: this.actorId,
    });
    if (error) throw error;
    if (data !== true) {
      throw new NotAuthorisedError(this.chatId, this.actorId);
    }
  }

  // -------------------------------------------------------------------------
  // Reads — each re-checks authorisation first
  // -------------------------------------------------------------------------

  /** Recent history, newest last. */
  async recentMessages(limit: number): Promise<Message[]> {
    await this.assertActorAuthorised();
    const { data, error } = await this.db
      .from('messages')
      .select('*')
      .eq('chat_id', this.chatId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as Message[]).reverse();
  }

  /** Files attached to this chat. A tool reaching for a file goes through here. */
  async listFiles(): Promise<FileRow[]> {
    await this.assertActorAuthorised();
    const { data, error } = await this.db
      .from('files')
      .select('*')
      .eq('chat_id', this.chatId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as FileRow[];
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** Persist the agent's reply. No client can insert a row with sender_type 'agent'. */
  async writeAgentMessage(content: string): Promise<Message> {
    const { data, error } = await this.db
      .from('messages')
      .insert({
        chat_id: this.chatId,
        sender_type: 'agent',
        sender_id: null,
        content,
        turn_id: this.turnId,
      })
      .select()
      .single();
    if (error) throw error;
    return data as Message;
  }

  // -------------------------------------------------------------------------
  // Privileged escape hatch
  // -------------------------------------------------------------------------

  /**
   * The underlying service-role client.
   *
   * @internal Exists for `lib/memory/*` and `lib/events/log.ts`, which need to
   * call the memory filter RPC and write the append-only audit trail. It is NOT
   * a general-purpose accessor: anything reached through it bypasses the
   * per-call authorisation checks above, so a caller takes on the job of doing
   * them. If you are writing a tool, use the domain methods instead.
   */
  privilegedClient(): SupabaseClient {
    return this.db;
  }
}

export class NotAuthorisedError extends Error {
  constructor(chatId: string, actorId: string) {
    super(`actor ${actorId} is not authorised for chat ${chatId}`);
    this.name = 'NotAuthorisedError';
  }
}

/**
 * Construct the service-role client. Module-private on purpose — the only way
 * to obtain one from outside this file is through a ScopedAgentContext, which
 * means through a chat scope.
 */
function createServiceClient(): SupabaseClient {
  const publicEnv = clientEnv();
  const secrets = serverEnv();
  return createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    secrets.SUPABASE_SECRET_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-quorum-actor': 'agent' } },
    },
  );
}
