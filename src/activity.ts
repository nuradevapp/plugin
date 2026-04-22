import { basename } from "path"

export interface FormattedActivity {
  tool: string
  summary: string
}

const BASH_CMD_MAX = 40

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "…"
}

export function formatActivity(
  toolName: string,
  toolInput: Record<string, unknown>
): FormattedActivity {
  const file = toolInput.file_path ? basename(toolInput.file_path as string) : null

  switch (toolName) {
    case "Read":
      return { tool: "Read", summary: file ? `Read ${file}` : "Read" }
    case "Edit":
      return { tool: "Edit", summary: file ? `Edit ${file}` : "Edit" }
    case "Write":
      return { tool: "Write", summary: file ? `Edit ${file}` : "Edit" }
    case "Bash": {
      const cmd = (toolInput.command as string | undefined) ?? ""
      return { tool: "Bash", summary: cmd ? `Bash: ${truncate(cmd, BASH_CMD_MAX)}` : "Bash" }
    }
    case "Grep": {
      const p = toolInput.pattern as string | undefined
      return { tool: "Grep", summary: p ? `Grep "${p}"` : "Grep" }
    }
    case "Glob": {
      const p = toolInput.pattern as string | undefined
      return { tool: "Glob", summary: p ? `Glob ${p}` : "Glob" }
    }
    case "Agent": {
      const t = toolInput.subagent_type as string | undefined
      return { tool: "Agent", summary: t ? `Agent: ${t}` : "Agent" }
    }
    case "WebFetch": {
      const url = toolInput.url as string | undefined
      if (!url) return { tool: "WebFetch", summary: "Fetch" }
      try {
        return { tool: "WebFetch", summary: `Fetch ${new URL(url).hostname}` }
      } catch {
        return { tool: "WebFetch", summary: "Fetch" }
      }
    }
    case "WebSearch": {
      const q = toolInput.query as string | undefined
      return { tool: "WebSearch", summary: q ? `Search "${q}"` : "Search" }
    }
    case "TaskCreate": {
      const title = toolInput.title as string | undefined
      return { tool: "TaskCreate", summary: title ? `Task: ${title}` : "Task" }
    }
    case "TaskUpdate": {
      const title = toolInput.title as string | undefined
      const status = toolInput.status as string | undefined
      if (title && status) return { tool: "TaskUpdate", summary: `Task ${status}: ${title}` }
      if (title) return { tool: "TaskUpdate", summary: `Update: ${title}` }
      return { tool: "TaskUpdate", summary: "Update task" }
    }
    case "TaskList":
      return { tool: "TaskList", summary: "Tasks" }
    default:
      return { tool: toolName, summary: toolName || "Working" }
  }
}
