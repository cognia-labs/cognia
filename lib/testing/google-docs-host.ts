/** Metadata-only offline IPC fixture. Native tests own OAuth and CAS behavior. */
import type {
  GoogleStateInput,
  GoogleStatePort,
  GoogleStateReply,
} from "@/lib/docs-providers/providers/google/state"

export function createGoogleDocsTestHost(initial: Partial<GoogleStateReply> = {}) {
  const snapshot: GoogleStateReply = {
    lineages: [],
    clients: [],
    pending: [],
    migrationNeedsClientId: false,
    ...initial,
  }
  const calls: GoogleStateInput[] = []
  const observers = new Set<() => void>()
  let serial = 0
  const host = {
    snapshot,
    calls,
    handle: undefined as
      ((input: GoogleStateInput) => Promise<GoogleStateReply | undefined>) | undefined,
    subscribe(observer: () => void) {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    },
    call: null as unknown as GoogleStatePort,
  }
  host.call = async (input) => {
    calls.push(input)
    const overridden = await host.handle?.(input)
    if (overridden) return overridden
    const reply = (): GoogleStateReply => structuredClone(snapshot)
    switch (input.action) {
      case "snapshot":
        return reply()
      case "setClientSecret":
      case "clearClientSecret": {
        snapshot.clients = snapshot.clients.filter((client) => client.clientId !== input.clientId)
        snapshot.clients.push({
          clientId: input.clientId,
          hasClientSecret: input.action === "setClientSecret",
        })
        break
      }
      case "begin":
      case "beginDevice": {
        const attemptId = `google:fixture-${++serial}`
        const expiresAt = Date.now() + 600_000
        const method = input.action === "begin" ? "loopback-pkce" : "device-code"
        snapshot.pending.push({
          attemptId,
          clientId: input.clientId,
          method,
          expiresAt,
          reauthorizeLineage: input.reauthorizeLineage,
        })
        const attempt =
          input.action === "begin"
            ? {
                attemptId,
                expiresAt,
                authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${attemptId}`,
              }
            : {
                attemptId,
                expiresAt,
                userCode: "ABCD",
                verificationUrl: "https://google.com/device",
                interval: 5,
              }
        return { ...reply(), attempt }
      }
      case "cancel":
        snapshot.pending = snapshot.pending.filter(
          (attempt) => attempt.attemptId !== input.attemptId
        )
        break
      case "disconnect": {
        const lineage = snapshot.lineages.find((value) => value.id === input.lineageId)
        if (lineage) {
          lineage.status = "disconnected"
          lineage.revision += ":disconnected"
        }
        for (const observer of observers) observer()
        return {
          ...reply(),
          outcome: { revoked: Boolean(lineage), ...(lineage ? {} : { reason: "not-connected" }) },
        }
      }
      case "pollDevice":
        return { ...reply(), pollStatus: "pending" }
      case "complete":
      case "accessToken":
        throw new Error(`Configure the Host fixture's ${input.action} response explicitly`)
    }
    for (const observer of observers) observer()
    return reply()
  }
  return host
}
