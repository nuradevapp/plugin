// Plugin → Relay
export type PluginMessage =
  | { type: "register_plugin"; sessionId?: string }
  | { type: "request_pairing_code" }
  | { type: "reply"; chat_id: string; text: string }
  | { type: "reply_with_detail"; chat_id: string; message: string; full_content: string }
  | { type: "status"; session_id: string; text: string }
  | { type: "permission_request"; request_id: string; tool_name: string; description: string; input_preview: string }
  | { type: "thinking" }

// Relay → Plugin
export type RelayMessage =
  | { type: "registered"; sessionId: string }
  | { type: "pairing_code"; code: string; expiresIn: number }
  | { type: "paired"; deviceId: string; pluginToken: string; pluginTokenId: string }
  | { type: "message"; chat_id: string; text: string }
  | { type: "permission_verdict"; request_id: string; allow: boolean }
  | { type: "app_disconnected" }
  | { type: "app_reconnected" }

export interface PermissionRequestParams {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}
