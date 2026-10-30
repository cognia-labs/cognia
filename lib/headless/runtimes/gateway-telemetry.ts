/** Persist native gateway usage/logs through the Host's authenticated events WS. */
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { installGatewayTelemetrySubscription } from "@/lib/gateway/telemetry-subscription"
import { transport } from "@/lib/tauri"
import {
  GATEWAY_REQUEST_LOG_EVENT,
  GATEWAY_REQUEST_OUTCOME_EVENT,
  type GatewayStatus,
} from "@/types/gateway"
import { registerHeadlessRuntime } from "../registry"

const AUTHORITY_TIMEOUT_MS = 3_000

type TelemetryAuthority = Pick<
  GatewayStatus,
  "ownerAccountId" | "accountGeneration" | "accountRequired"
>

registerHeadlessRuntime({
  name: "gateway-telemetry",
  criticality: "required",
  hosts: ["brain", "person-brain"],
  start: async (ctx) => {
    // serveCommand installs this CompanionTransport before bootstrapping us.
    // ctx.bridge is the separate request/response WS, not the event stream.
    const events = transport
    let active = true
    const current = () => active && getActiveAccountId() === ctx.localAccountId
    const stop = installGatewayTelemetrySubscription(events, {
      isCurrent: current,
      acceptsEvent: async (event) => {
        if (!current()) return false
        if (event.ownerAccountId != null && event.ownerAccountId !== ctx.localAccountId)
          return false
        if (ctx.host === "person-brain" && event.ownerAccountId !== ctx.localAccountId) return false
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const status = await Promise.race([
            ctx.host === "person-brain"
              ? events
                  .call<{ gatewayTelemetry?: TelemetryAuthority | null }>(
                    "person_agent_policy_get",
                    {}
                  )
                  .then((policy) => policy.gatewayTelemetry)
              : events.call<GatewayStatus>("gateway_status"),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("gateway_telemetry_authority_timeout")),
                AUTHORITY_TIMEOUT_MS
              )
            }),
          ])
          if (
            !current() ||
            !status ||
            !Number.isSafeInteger(status.accountGeneration) ||
            (status.accountGeneration ?? -1) < 0
          )
            return false
          if (status.accountRequired === false && event.ownerAccountId == null) {
            return (
              ctx.host === "brain" &&
              (event.accountGeneration === undefined ||
                event.accountGeneration === status.accountGeneration)
            )
          }
          if (
            event.accountGeneration !== status.accountGeneration ||
            event.ownerAccountId !== ctx.localAccountId
          )
            return false
          return status.ownerAccountId === ctx.localAccountId
        } catch {
          return false
        } finally {
          clearTimeout(timer)
        }
      },
    })
    try {
      if (!events.whenSubscribed) throw new Error("gateway_telemetry_events_unavailable")
      const channels = [GATEWAY_REQUEST_LOG_EVENT, GATEWAY_REQUEST_OUTCOME_EVENT]
      await events.whenSubscribed(channels, 5_000)
      if (!events.hasSubscribedChannels?.(channels))
        throw new Error("gateway_telemetry_events_unavailable")
    } catch (error) {
      active = false
      stop()
      throw error
    }
    return () => {
      active = false
      stop()
    }
  },
})
