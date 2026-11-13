/** Portable write-audience policy; credentials and approvals grant no disclosure. */
import type { PersonalMarkV1, PrincipalRefV1 } from "./acting-identity"

export type SinkAudienceV1 =
  | { kind: "person"; person: PrincipalRefV1 }
  | { kind: "host-local" }
  | { kind: "group"; members?: PrincipalRefV1[] }
  | { kind: "unknown"; label: string }

/** Host provenance is mandatory; session sources retain all explicit taint. */
export type PersonalSinkContext = {
  sessionId?: string
  executionRunId?: string
  sessionDerived?: true
  personalSources?: readonly PersonalSinkContext[]
  hostOrigin?: "typed-send" | "fixed-notice" | "background-service"
  unverifiedReason?: string
  receiptAttemptId?: string
} & (
  | {
      executionRunId: string
      sessionDerived?: never
      personalSources?: never
      hostOrigin?: never
      unverifiedReason?: never
    }
  | {
      sessionId: string
      sessionDerived: true
      executionRunId?: never
      personalSources?: never
      hostOrigin?: never
      unverifiedReason?: never
    }
  | {
      personalSources: readonly PersonalSinkContext[]
      executionRunId?: never
      sessionDerived?: never
      hostOrigin?: never
      unverifiedReason?: never
    }
  | {
      hostOrigin: "typed-send" | "fixed-notice" | "background-service"
      executionRunId?: never
      sessionDerived?: never
      personalSources?: never
      unverifiedReason?: never
    }
  | {
      unverifiedReason: string
      executionRunId?: never
      sessionDerived?: never
      personalSources?: never
      hostOrigin?: never
    }
)

/** Serialized values never establish a Host disclosure capability. */
export type PersonalDisclosureSeam = { phase: "unavailable" }

export type PersonalSinkDecision =
  | { outcome: "allow" }
  | { outcome: "narrow"; person: PrincipalRefV1 }
  | { outcome: "withhold"; persons: PrincipalRefV1[]; reason: string }

/** Unindexed on the existing action-review receipt; never stores the payload. */
export interface PersonalSinkReceipt {
  persons: PrincipalRefV1[]
  outcome: "narrow" | "withheld"
  /** Absent for opaque/unhashable payloads: disclosure can never unlock them. */
  contentHash?: string
  originalTarget: unknown
  disclosure?: {
    grantedBy: PrincipalRefV1
    grantedAt: number
    target: { adapterId: string; conversationKey: string }
    contentHash: string
    expiresAt: number
    /** Atomic consumption is bound to exactly one queued job, including its retries. */
    consumedAt?: number
    jobId?: string
  }
}

/** Group membership alone never proves an exclusively personal audience. */
export function decidePersonalSink(
  taint: readonly PersonalMarkV1[],
  audience: SinkAudienceV1,
  samePerson: (left: PrincipalRefV1, right: PrincipalRefV1) => boolean
): PersonalSinkDecision {
  if (!taint.length) return { outcome: "allow" }
  const persons: PrincipalRefV1[] = []
  for (const { person } of taint)
    if (!persons.some((existing) => samePerson(existing, person))) persons.push(person)
  const recipient =
    audience.kind === "person"
      ? audience.person
      : audience.kind === "host-local"
        ? { kind: "local-person" as const }
        : undefined
  if (recipient && taint.every(({ person }) => samePerson(person, recipient)))
    return { outcome: "allow" }
  if (persons.length === 1 && (audience.kind === "group" || audience.kind === "person"))
    return { outcome: "narrow", person: persons[0] }
  return {
    outcome: "withhold",
    persons,
    reason: persons.length > 1 ? "multiple-persons" : "audience-unproven",
  }
}
