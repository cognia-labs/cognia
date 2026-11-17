"use client"

/**
 * One tool call, drawn the same way wherever it appears: the main transcript
 * in every flow mode, a subagent's nested activity and the run panel.
 *
 * Bash gets the `$` prompt row, file tools the coloured-verb row with the full
 * path, and everything else (built-ins, plugin tools, unknown MCP tools) the
 * structured row. Each expands into its own body (live terminal output, code,
 * diffs, `ToolDetailBody`). There used to be a second, plainer grammar for
 * subagents and the simplified mode (`ToolCallRow`) that named the same call
 * differently and counted its lines differently; it is gone.
 */

import type { ToolUIPart } from "ai"

import { FileToolPart, isFileToolPart } from "./file-tool-part"
import { StructuredToolPart } from "./structured-tool-part"
import { TerminalToolPart } from "./terminal-tool-part"
import { isBashToolPart } from "./tool-detail-body"

export interface ToolCallViewProps {
  part: ToolUIPart
  sessionId?: string
  /** Initial disclosure for an uncontrolled row with nothing remembered. */
  defaultOpen?: boolean
  /** Controlled disclosure (a group drives its children). */
  expanded?: boolean
  onToggle?: () => void
  /** Remembers the reader's toggle by call identity across remounts. */
  memoryKey?: string
}

export function ToolCallView({
  part,
  sessionId,
  defaultOpen,
  expanded,
  onToggle,
  memoryKey,
}: ToolCallViewProps) {
  const disclosure = {
    ...(defaultOpen !== undefined ? { defaultOpen } : {}),
    ...(expanded !== undefined ? { expanded } : {}),
    ...(onToggle ? { onToggle } : {}),
    ...(memoryKey ? { memoryKey } : {}),
  }
  if (isBashToolPart(part)) return <TerminalToolPart part={part} {...disclosure} />
  if (isFileToolPart(part)) {
    return <FileToolPart part={part} {...(sessionId ? { sessionId } : {})} {...disclosure} />
  }
  return <StructuredToolPart part={part} {...(sessionId ? { sessionId } : {})} {...disclosure} />
}
