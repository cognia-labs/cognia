import type { PersonPartitionCapabilities } from "@cognia/agent-config-types/host-state"

let capability: PersonPartitionCapabilities = { chat: "none", execution: "none" }
let hostBootedAt: number | null = null

/**
 * Capture Host opt-in once at boot; older Hosts leave execution dormant.
 *
 * Both flags come from the Host's person-brain supervisor only (it strips them
 * from the operator environment). `COGNIA_PERSON_EXECUTION=sandboxed` is
 * advertised only while the Host's sandbox pool conforms (P6d), and is what
 * lets this partition run the member's agent (P6e).
 */
export function initializePersonChat(
  host: string,
  env: Readonly<Record<string, string | undefined>>
): void {
  const person = host === "person-brain"
  capability = Object.freeze({
    chat: person && env.COGNIA_PERSON_CHAT === "tool-less" ? "tool-less" : "none",
    execution: person && env.COGNIA_PERSON_EXECUTION === "sandboxed" ? "sandboxed" : "none",
  })
  hostBootedAt = person ? parseBootedAt(env.COGNIA_HOST_BOOTED_AT) : null
}

function parseBootedAt(value: string | undefined): number | null {
  if (!value || !/^\d{1,16}$/.test(value)) return null
  const at = Number(value)
  return Number.isSafeInteger(at) && at > 0 ? at : null
}

/**
 * When the Host process that started this brain booted (ADR-0253 §7), or
 * `null` outside a member's partition or under a Host that does not say.
 *
 * A turn this partition left in flight before that instant was interrupted by
 * the Host restarting, not by this brain alone. Like the flags above, only the
 * Host's person-brain supervisor sets it.
 */
export function personHostBootedAt(): number | null {
  return hostBootedAt
}

export function personChatCapability(): PersonPartitionCapabilities {
  return capability
}
