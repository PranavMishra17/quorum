export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_events: {
        Row: {
          chat_id: string
          created_at: string
          event_type: string
          id: string
          message_id: string | null
          payload: Json
          request_id: string
          turn_id: string
        }
        Insert: {
          chat_id: string
          created_at?: string
          event_type: string
          id?: string
          message_id?: string | null
          payload?: Json
          request_id: string
          turn_id: string
        }
        Update: {
          chat_id?: string
          created_at?: string
          event_type?: string
          id?: string
          message_id?: string | null
          payload?: Json
          request_id?: string
          turn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_events_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_events_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_members: {
        Row: {
          chat_id: string
          joined_at: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["member_role"]
          status: Database["public"]["Enums"]["member_status"]
          user_id: string
        }
        Insert: {
          chat_id: string
          joined_at?: string | null
          removed_at?: string | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: Database["public"]["Enums"]["member_status"]
          user_id: string
        }
        Update: {
          chat_id?: string
          joined_at?: string | null
          removed_at?: string | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: Database["public"]["Enums"]["member_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_members_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
        ]
      }
      chats: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string | null
          required_clearance_id: string | null
          type: Database["public"]["Enums"]["chat_type"]
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name?: string | null
          required_clearance_id?: string | null
          type: Database["public"]["Enums"]["chat_type"]
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string | null
          required_clearance_id?: string | null
          type?: Database["public"]["Enums"]["chat_type"]
        }
        Relationships: [
          {
            foreignKeyName: "chats_required_clearance_id_fkey"
            columns: ["required_clearance_id"]
            isOneToOne: false
            referencedRelation: "clearances"
            referencedColumns: ["id"]
          },
        ]
      }
      clearances: {
        Row: {
          description: string | null
          id: string
          key: string
          level: number
          name: string
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          level: number
          name: string
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          level?: number
          name?: string
        }
        Relationships: []
      }
      files: {
        Row: {
          chat_id: string
          created_at: string
          filename: string
          id: string
          mime_type: string
          size_bytes: number
          storage_path: string
          uploader_id: string
        }
        Insert: {
          chat_id: string
          created_at?: string
          filename: string
          id?: string
          mime_type: string
          size_bytes: number
          storage_path: string
          uploader_id: string
        }
        Update: {
          chat_id?: string
          created_at?: string
          filename?: string
          id?: string
          mime_type?: string
          size_bytes?: number
          storage_path?: string
          uploader_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "files_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_calls: {
        Row: {
          chat_id: string
          cost_estimate: number | null
          created_at: string
          error_type: string | null
          finished_at: string | null
          id: string
          input_tokens: number | null
          message_id: string | null
          model: string
          output_tokens: number | null
          purpose: string
          request_id: string
          started_at: string
          status: Database["public"]["Enums"]["llm_call_status"]
          tier: string
          turn_id: string
        }
        Insert: {
          chat_id: string
          cost_estimate?: number | null
          created_at?: string
          error_type?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          message_id?: string | null
          model: string
          output_tokens?: number | null
          purpose: string
          request_id: string
          started_at?: string
          status?: Database["public"]["Enums"]["llm_call_status"]
          tier: string
          turn_id: string
        }
        Update: {
          chat_id?: string
          cost_estimate?: number | null
          created_at?: string
          error_type?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          message_id?: string | null
          model?: string
          output_tokens?: number | null
          purpose?: string
          request_id?: string
          started_at?: string
          status?: Database["public"]["Enums"]["llm_call_status"]
          tier?: string
          turn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_calls_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_calls_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_audience: {
        Row: {
          memory_item_id: string
          user_id: string
        }
        Insert: {
          memory_item_id: string
          user_id: string
        }
        Update: {
          memory_item_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_audience_memory_item_id_fkey"
            columns: ["memory_item_id"]
            isOneToOne: false
            referencedRelation: "memory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_items: {
        Row: {
          clearance_level: number
          confidence: number
          content: string
          created_at: string
          expires_at: string | null
          id: string
          origin_chat_id: string
          origin_message_id: string | null
          search_vector: unknown
          source_type: Database["public"]["Enums"]["memory_source"]
          status: Database["public"]["Enums"]["memory_status"]
          subject_user_id: string
          superseded_by: string | null
        }
        Insert: {
          clearance_level: number
          confidence: number
          content: string
          created_at?: string
          expires_at?: string | null
          id?: string
          origin_chat_id: string
          origin_message_id?: string | null
          search_vector?: unknown
          source_type: Database["public"]["Enums"]["memory_source"]
          status?: Database["public"]["Enums"]["memory_status"]
          subject_user_id: string
          superseded_by?: string | null
        }
        Update: {
          clearance_level?: number
          confidence?: number
          content?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          origin_chat_id?: string
          origin_message_id?: string | null
          search_vector?: unknown
          source_type?: Database["public"]["Enums"]["memory_source"]
          status?: Database["public"]["Enums"]["memory_status"]
          subject_user_id?: string
          superseded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memory_items_origin_chat_id_fkey"
            columns: ["origin_chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_items_origin_message_id_fkey"
            columns: ["origin_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_items_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "memory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          chat_id: string
          client_message_id: string | null
          content: string
          created_at: string
          id: string
          sender_id: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
          turn_id: string
        }
        Insert: {
          chat_id: string
          client_message_id?: string | null
          content: string
          created_at?: string
          id?: string
          sender_id?: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
          turn_id?: string
        }
        Update: {
          chat_id?: string
          client_message_id?: string | null
          content?: string
          created_at?: string
          id?: string
          sender_id?: string | null
          sender_type?: Database["public"]["Enums"]["sender_type"]
          turn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          color: string
          created_at: string
          display_name: string
          id: string
        }
        Insert: {
          avatar_url?: string | null
          color?: string
          created_at?: string
          display_name: string
          id: string
        }
        Update: {
          avatar_url?: string | null
          color?: string
          created_at?: string
          display_name?: string
          id?: string
        }
        Relationships: []
      }
      user_clearances: {
        Row: {
          clearance_id: string
          granted_at: string
          granted_by: string | null
          user_id: string
        }
        Insert: {
          clearance_id: string
          granted_at?: string
          granted_by?: string | null
          user_id: string
        }
        Update: {
          clearance_id?: string
          granted_at?: string
          granted_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_clearances_clearance_id_fkey"
            columns: ["clearance_id"]
            isOneToOne: false
            referencedRelation: "clearances"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_access_chat_for: {
        Args: { p_chat_id: string; p_user_id: string }
        Returns: boolean
      }
      claim_base_clearance: { Args: never; Returns: undefined }
      create_chat: {
        Args: {
          p_member_ids: string[]
          p_name: string
          p_required_clearance_id: string
          p_type: Database["public"]["Enums"]["chat_type"]
        }
        Returns: string
      }
      grant_clearance: {
        Args: { p_clearance_id: string; p_user_id: string }
        Returns: undefined
      }
      memory_for_chat: {
        Args: { p_chat_id: string; p_query: string }
        Returns: {
          clearance_level: number
          confidence: number
          content: string
          created_at: string
          id: string
          origin_chat_id: string
          relevance: number
          source_type: Database["public"]["Enums"]["memory_source"]
          subject_user_id: string
        }[]
      }
      revoke_clearance: {
        Args: { p_clearance_id: string; p_user_id: string }
        Returns: undefined
      }
      send_message_and_start_turn: {
        Args: {
          p_chat_id: string
          p_client_message_id: string
          p_content: string
        }
        Returns: {
          is_duplicate: boolean
          message_id: string
          turn_id: string
        }[]
      }
      write_memory_item: {
        Args: {
          p_clearance_level: number
          p_confidence: number
          p_content: string
          p_expires_at: string
          p_origin_chat_id: string
          p_origin_message_id: string
          p_source_type: Database["public"]["Enums"]["memory_source"]
          p_status: Database["public"]["Enums"]["memory_status"]
          p_subject_user_id: string
        }
        Returns: string
      }
    }
    Enums: {
      chat_type: "dm" | "group" | "agent"
      llm_call_status: "started" | "succeeded" | "failed"
      member_role: "admin" | "member"
      member_status: "member" | "requested" | "invited" | "removed"
      memory_source: "stated" | "inferred"
      memory_status: "candidate" | "active" | "superseded" | "stale"
      sender_type: "user" | "agent"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      chat_type: ["dm", "group", "agent"],
      llm_call_status: ["started", "succeeded", "failed"],
      member_role: ["admin", "member"],
      member_status: ["member", "requested", "invited", "removed"],
      memory_source: ["stated", "inferred"],
      memory_status: ["candidate", "active", "superseded", "stale"],
      sender_type: ["user", "agent"],
    },
  },
} as const
