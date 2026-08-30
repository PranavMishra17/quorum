/**
 * Database types.
 *
 * PLACEHOLDER — hand-authored from `supabase/migrations/`. Replace with
 * generated output as soon as a Supabase project exists:
 *
 *   pnpm supabase gen types typescript --linked > lib/db/types.ts
 *
 * After that point this file is generated output and must never be hand-edited;
 * regenerate it instead. It is written by hand now only so that query results
 * have real shapes before the project is provisioned. See the note at the foot
 * of this file for why the clients are not parameterised with it.
 */

export type ChatType = 'dm' | 'group' | 'agent';
export type MemberRole = 'admin' | 'member';
export type MemberStatus = 'member' | 'requested' | 'invited' | 'removed';
export type SenderType = 'user' | 'agent';
export type MemorySource = 'stated' | 'inferred';
export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'stale';
export type LlmCallStatus = 'started' | 'succeeded' | 'failed';

export interface Profile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  color: string;
  created_at: string;
}

export interface Clearance {
  id: string;
  key: string;
  name: string;
  level: number;
  description: string | null;
}

export interface UserClearance {
  user_id: string;
  clearance_id: string;
  granted_at: string;
  granted_by: string | null;
}

export interface Chat {
  id: string;
  type: ChatType;
  name: string | null;
  created_by: string;
  required_clearance_id: string | null;
  created_at: string;
}

export interface ChatMember {
  chat_id: string;
  user_id: string;
  role: MemberRole;
  status: MemberStatus;
  joined_at: string | null;
  removed_at: string | null;
}

export interface Message {
  id: string;
  chat_id: string;
  sender_type: SenderType;
  sender_id: string | null;
  content: string;
  client_message_id: string | null;
  turn_id: string;
  created_at: string;
}

export interface AgentEvent {
  id: string;
  chat_id: string;
  turn_id: string;
  request_id: string;
  message_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface LlmCall {
  id: string;
  chat_id: string;
  turn_id: string;
  request_id: string;
  message_id: string | null;
  model: string;
  tier: string;
  purpose: string;
  status: LlmCallStatus;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_estimate: string | null;
  error_type: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

export interface MemoryItem {
  id: string;
  subject_user_id: string;
  origin_chat_id: string;
  origin_message_id: string | null;
  content: string;
  clearance_level: number;
  source_type: MemorySource;
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface FileRow {
  id: string;
  chat_id: string;
  uploader_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

/**
 * NOTE ON TYPING THE CLIENT
 *
 * The Supabase clients are intentionally NOT parameterised with a hand-written
 * `Database` generic. That type has an internal shape the SDK evolves, and
 * hand-approximating it produced `never` inference rather than safety — a type
 * that lies is worse than no type.
 *
 * So query results are cast to the interfaces above at the call site, where the
 * cast is visible. When `supabase gen types` runs against a real project, the
 * generic goes back on and the casts come out.
 */
