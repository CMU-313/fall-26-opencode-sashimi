const MAX_DESCRIPTION_LENGTH = 120

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeControlChars = (value: string) =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]+/g, " ")

const sanitizeText = (value: unknown): string => {
  if (typeof value !== "string") return ""
  return normalizeControlChars(value).replace(/\s+/g, " ").trim()
}

const sanitizeForSummary = (value: unknown): string => {
  if (typeof value !== "string") return ""
  return normalizeControlChars(value).trim()
}

const truncateText = (value: string, maxLength = MAX_DESCRIPTION_LENGTH): string => {
  const text = sanitizeText(value)
  if (!text) return ""
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

const getString = (record: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string") {
      const text = sanitizeText(value)
      if (text) return text
    }
  }
  return ""
}

const getStringForSummary = (record: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string") {
      const text = sanitizeForSummary(value)
      if (text) return text
    }
  }
  return ""
}

const getNested = (record: Record<string, unknown>): Record<string, unknown> => {
  const input = isRecord(record.input) ? record.input : {}
  return { ...input, ...record }
}

const choosePath = (record: Record<string, unknown>): string => {
  return getString(record, ["path", "filePath", "filepath", "file", "target", "resource"]) || ""
}

const summarizeWrite = (content: string): string | undefined => {
  const raw = sanitizeForSummary(content)
  if (!raw) return undefined
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length > 1) return `${lines.length} lines`
  return `${Math.max(1, raw.length)} characters`
}

const summarizeCommand = (command: string): string => truncateText(command, 90)

const describeRead = (record: Record<string, unknown>) => {
  const path = choosePath(record)
  if (path) return `Agent wants to read the file ${path}`
  return "Agent wants to read a file"
}

const describeWrite = (record: Record<string, unknown>) => {
  const path = choosePath(record)
  const content = getStringForSummary(record, ["content", "newString", "text", "body"])
  const summary = summarizeWrite(content)
  if (path && summary) return `Agent wants to write ${summary} to ${path}`
  if (path) return `Agent wants to write to ${path}`
  if (summary) return `Agent wants to write ${summary}`
  return "Agent wants to write a file"
}

const describeEdit = (record: Record<string, unknown>) => {
  const path = choosePath(record)
  if (path) return `Agent wants to edit ${path}`
  return "Agent wants to edit a file"
}

const describeShell = (record: Record<string, unknown>) => {
  const command = getString(record, ["command", "cmd"])
  if (command) return `Agent wants to run: ${summarizeCommand(command)}`
  return "Agent wants to run a shell command"
}

const describePatternAction = (permission: string, record: Record<string, unknown>) => {
  const pattern = getString(record, ["pattern", "query", "url", "href", "name"])
  const label = {
    glob: "find files matching",
    grep: "search for",
    webfetch: "fetch",
    websearch: "search the web for",
  }[permission]

  if (!pattern || !label) return undefined
  return `Agent wants to ${label} ${truncateText(pattern, 80)}`
}

export function explainPermissionReq(permission: string, metadata: unknown): string {
  const record = getNested(isRecord(metadata) ? metadata : {})

  switch (permission) {
    case "read":
      return describeRead(record)
    case "write":
      return describeWrite(record)
    case "edit":
      return describeEdit(record)
    case "bash":
    case "shell":
      return describeShell(record)
    case "glob":
    case "grep":
    case "webfetch":
    case "websearch":
      return describePatternAction(permission, record) ?? "Agent wants to run a tool"
    case "todowrite":
      return "Agent wants to update the todo list"
    case "skill": {
      const name = truncateText(getString(record, ["name", "skill"]), 50)
      if (!name) return "Agent wants to load a skill"
      return `Agent wants to load the skill ${name}`
    }
    default: {
      const firstSignal = getString(record, ["command", "path", "filePath", "filepath", "query", "pattern", "url", "name", "description"])
      if (!firstSignal) return `Agent wants to run ${permission}`
      return `Agent wants to run ${permission}: ${truncateText(firstSignal, 80)}`
    }
  }
}
