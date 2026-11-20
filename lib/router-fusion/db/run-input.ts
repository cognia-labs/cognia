/**
 * A Run API run's input, as it is stored (ADR-0188 B2/B3).
 *
 * `POST /v1/runs` answers 202 and the request is gone. Everything a worker
 * needs to execute the run later — after a reload, on another window, after a
 * crash — is therefore stored with the run as one encrypted artifact: the
 * messages, the request's own options that change how the run is judged
 * (whether a degraded result is acceptable, the structured output it asked
 * for), and, for a delegate run a person answered, the questions their
 * answers reply to.
 */

import type { Message } from "@cognia/router-fusion"

export interface StoredRunInput {
  messages: Message[]
  /** The request accepts an explicitly degraded result (spec `allow_degraded`). */
  allowDegraded: boolean
  /** The structured answer a chat-compat caller asked for (`response_format.json_schema`). */
  jsonSchema: Record<string, unknown> | null
  /**
   * The questions the run asked a person, one round per resume, oldest first
   * (a delegate lead's `need_input`). Each round's answers are the user
   * messages that resume appended. Absent until a person answered once.
   */
  clarifications?: string[][]
}

const ROLES = new Set(["system", "user", "assistant"])

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { role?: unknown; content?: unknown }
  return (
    typeof candidate.content === "string" &&
    typeof candidate.role === "string" &&
    ROLES.has(candidate.role)
  )
}

function clarificationsOf(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value
    .filter((round): round is unknown[] => Array.isArray(round))
    .map((round) => round.filter((q): q is string => typeof q === "string" && q.length > 0))
    .filter((round) => round.length > 0)
}

export function encodeRunInput(input: StoredRunInput): string {
  return JSON.stringify(input)
}

/** The stored input, or null when there is nothing a run could be sent with. */
export function decodeRunInput(content: string | null | undefined): StoredRunInput | null {
  if (!content) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as {
    messages?: unknown
    allowDegraded?: unknown
    jsonSchema?: unknown
    clarifications?: unknown
  }
  const messages = Array.isArray(record.messages) ? record.messages.filter(isMessage) : []
  if (messages.length === 0) return null
  const schema = record.jsonSchema
  const clarifications = clarificationsOf(record.clarifications)
  return {
    messages,
    allowDegraded: record.allowDegraded === true,
    jsonSchema:
      typeof schema === "object" && schema !== null && !Array.isArray(schema)
        ? (schema as Record<string, unknown>)
        : null,
    ...(clarifications.length > 0 ? { clarifications } : {}),
  }
}
