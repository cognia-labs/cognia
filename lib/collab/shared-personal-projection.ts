/** Personal-content projection shared by stored collaboration events and live frames. */
import type { SessionMembership } from "@cognia/agent-config-types"
import {
  mergePersonalMarks,
  type PersonalMarkV1,
  type PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import {
  withholdForReaders,
  type PersonalHistoryMessage,
} from "@cognia/plugin-contract/types/execution/personal-visibility"
import { samePersonForHost, type HostPersonContext } from "@/lib/execution/personal-visibility"

/** Membership is read from the authenticated service, never from message metadata. */
export function sharedPersonalReaders(
  members: readonly SessionMembership[],
  hostUserId: string,
  authority: string
): PrincipalRefV1[] {
  return members.map((member) =>
    member.userId === hostUserId
      ? { kind: "local-person" }
      : {
          kind: "platform",
          platform: "cognia-collab",
          adapterId: authority,
          remoteUserId: member.userId,
        }
  )
}

/** Unknown run provenance is private; it cannot turn into an unmarked live frame. */
export const UNVERIFIED_SHARED_PERSONAL_MARK: PersonalMarkV1 = {
  person: { kind: "service", ref: "unverified-personal-history" },
  source: "unverified-shared-run",
  markedAt: 0,
}

/**
 * Apply Host-held run marks before the assistant projector strips metadata.
 * No execution id is ever selected from the source message's metadata.
 */
export function projectSharedPersonalMessages<T extends PersonalHistoryMessage>(
  messages: readonly T[],
  readers: readonly PrincipalRefV1[],
  host: HostPersonContext,
  options: {
    marks?: readonly PersonalMarkV1[]
    session?: { platformBinding?: unknown }
    boundPerson?: PrincipalRefV1
  } = {}
) {
  const marked = options.marks?.length
    ? messages.map((message) => ({
        ...message,
        metadata: {
          ...(message.metadata as Record<string, unknown> | undefined),
          personalMarks: mergePersonalMarks(
            (message.metadata as { personalMarks?: PersonalMarkV1[] } | undefined)?.personalMarks,
            [...options.marks!]
          ),
        },
      }))
    : messages
  return withholdForReaders(marked, readers, options.session, {
    boundPerson: options.boundPerson,
    samePerson: (left, right) => samePersonForHost(left, right, host),
  })
}

/** Titles and edited summaries keep their durable source taint, including deleted rows. */
export async function projectSharedDerivedText(
  text: string,
  sourceSessionId: string,
  sourceRunId: string | undefined,
  target: unknown
): Promise<string> {
  const { checkPersonalSink, mergePersonalSinkContexts, sessionPersonalSinkContext } =
    await import("@/lib/execution/personal-sink")
  const sessionContext = sessionPersonalSinkContext(sourceSessionId)
  const context = sourceRunId
    ? mergePersonalSinkContexts(sessionContext, { executionRunId: sourceRunId })
    : sessionContext
  const decision = await checkPersonalSink(context, { kind: "group" }, text, target)
  if (decision.outcome === "allow") return text
  return (
    withholdForReaders(
      [
        {
          id: "shared-derived",
          text,
          metadata: {
            personalMarks: decision.persons.length
              ? decision.persons.map((person) => ({
                  person,
                  source: "shared-derived",
                  markedAt: 0,
                }))
              : [UNVERIFIED_SHARED_PERSONAL_MARK],
          },
        },
      ],
      []
    ).messages[0].text ?? ""
  )
}
