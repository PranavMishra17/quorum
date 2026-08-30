import type { Database } from './types';

/**
 * Row and enum aliases, DERIVED from the generated types.
 *
 * `types.ts` is `supabase gen types` output and must never be hand-edited. This
 * file is the hand-written half: short names for the shapes the application
 * actually passes around, each one projected from the generated schema so that
 * a column change shows up here as a type error rather than as a runtime
 * surprise.
 *
 * Regenerate with:
 *
 *   pnpm supabase gen types typescript --linked > lib/db/types.ts
 *
 * On Windows, `>` in PowerShell writes UTF-16. If the build starts failing with
 * unreadable identifiers, that is why — re-save the file as UTF-8.
 */

type Tables = Database['public']['Tables'];
type Enums = Database['public']['Enums'];

export type Profile = Tables['profiles']['Row'];
export type Clearance = Tables['clearances']['Row'];
export type UserClearance = Tables['user_clearances']['Row'];
export type Chat = Tables['chats']['Row'];
export type ChatMember = Tables['chat_members']['Row'];
export type Message = Tables['messages']['Row'];
export type AgentEvent = Tables['agent_events']['Row'];
export type LlmCall = Tables['llm_calls']['Row'];
export type MemoryItem = Tables['memory_items']['Row'];
export type FileRow = Tables['files']['Row'];

export type ChatType = Enums['chat_type'];
export type MemberRole = Enums['member_role'];
export type MemberStatus = Enums['member_status'];
export type SenderType = Enums['sender_type'];
export type MemorySource = Enums['memory_source'];
export type MemoryStatus = Enums['memory_status'];
export type LlmCallStatus = Enums['llm_call_status'];

export type { Database };

/**
 * Arguments for a Postgres function.
 *
 * Generated RPC argument types do not model SQL NULL: a `text` parameter that
 * happily accepts NULL is generated as `string`. Several functions here take
 * genuinely optional arguments (`create_chat`'s name and clearance,
 * `write_memory_item`'s expiry), so call sites cast through this rather than
 * pretending the value is always present.
 */
export type RpcArgs<K extends keyof Database['public']['Functions']> =
  Database['public']['Functions'][K]['Args'];
