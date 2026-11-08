/** Adapt the CLI's canonical JSONL records to the Host's one visibility filter. */
import type { SendOptions } from "@cognia/agent-config-types"
import { withholdForReaders } from "@cognia/plugin-contract/types/execution/personal-visibility"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { readTranscript, type TranscriptEntry, type TranscriptFs } from "./transcript"

export async function prepareCliPersonalHistory(
  home: string,
  sessionId: string,
  fsx?: TranscriptFs
) {
  return prepareCliPersonalMessages(sessionId, readTranscript(home, sessionId, fsx))
}

/** Imported desktop handoffs pass this boundary before formatting or summarizing. */
export async function prepareCliPersonalMessages(
  sessionId: string,
  records: readonly TranscriptEntry[]
) {
  const entries = records.map((entry, index) => ({
    ...entry,
    // Older JSONL records predate message ids. Position and timestamp remain
    // stable across restart, and do not expose content in the visibility key.
    id: entry.id ?? `cli:${index}:${entry.ts}`,
    createdAt: entry.ts,
  }))
  // A standalone CLI without IndexedDB has no Host identity or adapter binding.
  // Imported records already carry portable marks; none can grant a reader.
  const prepared =
    typeof indexedDB === "undefined"
      ? withholdForReaders(entries, [])
      : await preparePersonalHistory(sessionId, entries)
  return { ...prepared, entries: records }
}

/** Discard opaque provider memory and seed only filtered canonical messages. */
export function rebuildCliPersonalHistory(
  options: SendOptions,
  messages: readonly Pick<TranscriptEntry, "role" | "content">[],
  appendSystemPrompt: string | undefined
): void {
  delete options.resumeSessionId
  delete options.forkFromSessionId
  if (options.claudeAgentSdk) {
    options.claudeAgentSdk = {
      ...options.claudeAgentSdk,
      sessionId: undefined,
      continue: undefined,
    }
  }
  // Both rails use initialConversation as the existing live-loop replacement
  // fence. The native SDK receives the canonical text in its system preamble.
  const native =
    (options.execution?.runtimeAdapter ??
      (options.provider === "anthropic" ? "claude-agent-sdk" : "ai-sdk")) === "claude-agent-sdk"
  options.initialConversation = native
    ? []
    : messages.map(({ role, content }) => ({ role, content }))
  if (native) {
    const seed = messages.map(({ role, content }) => `${role}: ${content}`).join("\n\n")
    options.appendSystemPrompt = [
      appendSystemPrompt,
      seed ? `[Conversation history]\n\n${seed}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
  }
}
