import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { clientEnv, serverEnv } from '@/config';
import { openToken } from '@/lib/connectors/crypto';
import type { Database, FileRow, Message } from './rows';

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
    private readonly db: SupabaseClient<Database>,
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
   * This chat's clearance floor, named — null when ungated.
   *
   * For the prompt, not the filter: `clearanceLevel()` above is what
   * authorisation math runs on. This is purely so the agent can be told "this
   * room requires Confidential" in words, and only that — nothing here is the
   * ACTOR'S own held level, and nothing here is any OTHER chat's requirement.
   * Both of those would be exactly the kind of cross-room fact this project
   * exists to keep out of the model's context; a room's OWN requirement is not,
   * because every member already sees it in the UI (the `ClearanceStamp` on the
   * chat header) — telling the agent repeats something already visible to
   * everyone here, rather than disclosing anything new.
   */
  async clearanceLabel(): Promise<{ level: number; name: string } | null> {
    const { data, error } = await this.db
      .from('chats')
      .select('clearances:required_clearance_id(level, name)')
      .eq('id', this.chatId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { clearances?: { level: number; name: string } | null } | null;
    return row?.clearances ?? null;
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

  /** This chat's type and name. Used to shape the prompt and the gate input. */
  async chatSummary(): Promise<{ type: 'dm' | 'group' | 'agent'; name: string | null }> {
    const { data, error } = await this.db
      .from('chats')
      .select('type, name')
      .eq('id', this.chatId)
      .single();
    if (error) throw error;
    return data as { type: 'dm' | 'group' | 'agent'; name: string | null };
  }

  /**
   * Display names for everyone who appears in this chat's history.
   *
   * Note it resolves names for SENDERS, not for arbitrary users — the query is
   * bounded by this chat's messages and membership. A method that took a user
   * id and returned a profile would be a directory lookup wearing a context's
   * clothes.
   */
  async speakerNames(): Promise<Map<string, string>> {
    const [{ data: members }, { data: senders }] = await Promise.all([
      this.db.from('chat_members').select('user_id').eq('chat_id', this.chatId),
      this.db.from('messages').select('sender_id').eq('chat_id', this.chatId).not('sender_id', 'is', null),
    ]);

    const ids = new Set<string>();
    for (const r of (members ?? []) as { user_id: string }[]) ids.add(r.user_id);
    for (const r of (senders ?? []) as { sender_id: string | null }[]) {
      if (r.sender_id) ids.add(r.sender_id);
    }
    if (ids.size === 0) return new Map();

    const { data, error } = await this.db
      .from('profiles')
      .select('id, display_name')
      .in('id', [...ids]);
    if (error) throw error;

    return new Map(
      ((data ?? []) as { id: string; display_name: string }[]).map((p) => [p.id, p.display_name]),
    );
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

  /**
   * Read one file's bytes.
   *
   * `fileId` is a RESOURCE id, not a scope id — the distinction the invariant
   * turns on. Scope still comes from construction: the lookup below is
   * constrained by `this.chatId`, so a file id from another chat resolves to
   * nothing no matter where the id came from.
   *
   * That is the confused-deputy fix in one line. Knowing a resource id must
   * never be sufficient to read it, because tool input is model-controlled and
   * therefore influenced by whatever the model has read.
   */
  async readFile(fileId: string): Promise<{ meta: FileRow; bytes: ArrayBuffer } | null> {
    await this.assertActorAuthorised();

    const { data, error } = await this.db
      .from('files')
      .select('*')
      .eq('id', fileId)
      .eq('chat_id', this.chatId) // ← scope, from construction
      .maybeSingle();

    if (error || !data) return null;
    const meta = data as FileRow;

    const { data: blob, error: downloadError } = await this.db.storage
      .from('chat-files')
      .download(meta.storage_path);

    if (downloadError || !blob) return null;
    return { meta, bytes: await blob.arrayBuffer() };
  }

  /**
   * The turn actor's Google connector refresh token, decrypted, or null.
   *
   * ---------------------------------------------------------------------------
   * IT TAKES NO PARAMETER, AND THAT IS THE POINT
   *
   * The obvious signature is `connectorToken(userId, provider)`. Both arguments
   * would be a leak: the first is a scope-defining id, so a crafted document
   * could get the model to name someone else and read THEIR mailbox; the
   * second only looks harmless because there happens to be one provider today.
   *
   * So the subject comes from `this.actorId` and the provider is fixed. The
   * mailbox reachable in this turn is the mailbox of the person whose message
   * started it. Alice connecting her mail does not let the agent read it on
   * Bob's behalf, in a chat Alice is not in, or in a turn Alice did not start.
   *
   * Authorisation is re-checked first, like every other privileged read: a
   * turn whose actor lost access mid-flight must not then read their mail into
   * a chat they are no longer in.
   *
   * `connector_tokens` has RLS on and NO policy, so this is unreachable from
   * the browser at all — see migration 0014.
   */
  async googleConnectorToken(): Promise<{ token: string; scopes: string[] } | null> {
    await this.assertActorAuthorised();

    // `connector_tokens` appears in the generated types only once 0014 has been
    // pushed and `pnpm supabase gen types` re-run. Typed by hand here rather
    // than blocking the build on a deploy step; the shape is checked below and
    // the migration is the source of truth either way. Delete the cast after
    // the next regeneration.
    const { data, error } = await (this.db as SupabaseClient)
      .from('connector_tokens')
      .select('refresh_token_encrypted, scopes, revoked_at')
      .eq('user_id', this.actorId) // ← subject, from construction
      .eq('provider', 'google')
      .maybeSingle();

    if (error || !data) return null;
    const row = data as { refresh_token_encrypted: string; scopes: string[]; revoked_at: string | null };
    if (row.revoked_at) return null;

    try {
      return { token: openToken(row.refresh_token_encrypted), scopes: row.scopes ?? [] };
    } catch {
      // Undecryptable means tampered-with or encrypted under a rotated key.
      // Either way it is not a credential we may use — treat it as absent
      // rather than passing bytes of unknown provenance to Google.
      console.error('[connector] stored google token could not be decrypted', {
        userId: this.actorId,
      });
      return null;
    }
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
  privilegedClient(): SupabaseClient<Database> {
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
function createServiceClient(): SupabaseClient<Database> {
  const publicEnv = clientEnv();
  const secrets = serverEnv();
  return createClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    secrets.SUPABASE_SECRET_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-quorum-actor': 'agent' } },
    },
  );
}
