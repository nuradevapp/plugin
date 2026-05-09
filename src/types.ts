// Plugin → Relay
export type PluginMessage =
  | { type: "register_plugin"; sessionId?: string }
  | { type: "request_pairing_code" }
  | { type: "reply"; session_id: string; text: string; image_base64?: string; image_media_type?: string }
  | { type: "reply_with_detail"; session_id: string; message: string; full_content: string; image_base64?: string; image_media_type?: string }
  | { type: "status"; session_id: string; text: string }
  | { type: "task_update"; session_id: string; task: TaskSummary }
  | {
      type: "activity_event"
      session_id: string
      event: {
        id: string
        phase: "start" | "end"
        tool: string
        summary: string
        timestamp: number
      }
    }
  | { type: "activity_clear"; session_id: string }
  | { type: "permission_request"; session_id: string | null; request_id: string; tool_name: string; description: string; input_preview: string }
  | { type: "ask_user_question"
      session_id: string
      request_id: string
      questions: AskUserQuestion[]
    }
  | { type: "thinking"; session_id: string }

export interface TaskSummary {
  id: string
  title?: string
  status: "pending" | "in_progress" | "completed"
  description?: string
}

export interface AskUserQuestion {
  question:    string
  header:      string
  multiSelect: boolean
  options:     Array<{ label: string; description: string; preview?: string }>
}

// Relay → Plugin
export type RelayMessage =
  | { type: "registered"; sessionId: string }
  | { type: "pairing_code"; code: string; expiresIn: number }
  | { type: "paired"; deviceId: string; pluginToken: string; pluginTokenId: string }
  | { type: "message"; chat_id: string; text: string; image_base64?: string; image_media_type?: string; file_base64?: string; file_name?: string; file_media_type?: string }
  | { type: "permission_verdict"; request_id: string; allow: boolean }
  | { type: "ask_user_question_verdict"
      request_id: string
      answers?: Record<string, string>
      cancelled?: boolean
    }
  | { type: "app_disconnected" }
  | { type: "app_reconnected" }
  | { type: "command"; session_id: string; command: string }

export interface PermissionRequestParams {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}
