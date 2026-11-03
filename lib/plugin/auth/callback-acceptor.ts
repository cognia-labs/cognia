import { assertRuntimeSupported } from "@/lib/external-services/runtime-support"
import { currentRuntimeProfile } from "@/lib/plugin/character-pack/platform-availability"
import type { AuthCallbackParams } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  AuthAttemptRejected,
  consumeAttempt,
  cancelAttempt,
  type AttemptBinding,
  type AuthAttempt,
} from "./auth-attempts"

export type AuthCallbackSource = "broadcast" | "message" | "deep-link" | "pkce-driver"
interface AcceptedCallback {
  attempt: AuthAttempt
  callback: AuthCallbackParams
}
interface Waiter {
  binding: AttemptBinding
  resolve(value: AcceptedCallback): void
  reject(error: unknown): void
}

/** One Host acceptor, regardless of the transport which delivered a redirect. */
export class AuthCallbackAcceptor {
  private readonly waiters = new Map<string, Waiter>()
  constructor(
    private readonly consume = consumeAttempt,
    private readonly cancel = cancelAttempt,
    private readonly log: (reason: string, source: AuthCallbackSource) => void = (reason, source) =>
      console.warn("Auth callback dropped", { reason, source })
  ) {}
  registerWaiter(state: string, binding: AttemptBinding, expiresAt = Date.now() + 10 * 60 * 1000) {
    if (this.waiters.has(state))
      throw new Error("An auth callback waiter already exists for this state")
    let waiter!: Waiter
    const promise = new Promise<AcceptedCallback>((resolve, reject) => {
      waiter = { binding: { ...binding }, resolve, reject }
    })
    this.waiters.set(state, waiter)
    const timer = setTimeout(
      () => {
        if (this.waiters.get(state) === waiter) {
          this.waiters.delete(state)
          waiter.reject(new AuthAttemptRejected("expired"))
          void this.cancel(state).catch(() => {})
        }
      },
      Math.max(0, expiresAt - Date.now())
    )
    const bounded = promise.finally(() => clearTimeout(timer))
    return {
      promise: bounded,
      cancel: async () => {
        if (this.waiters.get(state) === waiter) {
          this.waiters.delete(state)
          waiter.reject(new AuthAttemptRejected("cancelled"))
        }
        await this.cancel(state)
      },
    }
  }
  async acceptCallback(params: AuthCallbackParams, source: AuthCallbackSource): Promise<boolean> {
    const waiter = this.waiters.get(params.state)
    try {
      if (!params.state || (!params.code && !params.error)) {
        this.log("invalid-callback", source)
        return false
      }
      if (!waiter) {
        this.log("no-pending-waiter", source)
        return false
      }
      const attempt = await this.consume(params.state, waiter.binding)
      if (this.waiters.get(params.state) !== waiter) {
        this.log("cancelled", source)
        return false
      }
      this.waiters.delete(params.state)
      waiter.resolve({
        attempt,
        callback: {
          state: params.state,
          code: params.code,
          error: params.error,
          errorDescription: params.errorDescription,
        },
      })
      return true
    } catch (error) {
      if (
        !(error instanceof AuthAttemptRejected) &&
        waiter &&
        this.waiters.get(params.state) === waiter
      ) {
        this.waiters.delete(params.state)
        waiter.reject(error)
      }
      this.log(error instanceof AuthAttemptRejected ? error.reason : "storage-unavailable", source)
      return false
    }
  }
  /** Old provider URI handlers remain installed; Host attempts still own their new states. */
  async acceptPluginCallback(
    pluginId: string,
    path: string,
    query: Record<string, string>
  ): Promise<boolean> {
    if (path !== "oauth-callback" || this.waiters.get(query.state)?.binding.providerId !== pluginId)
      return false
    return this.acceptCallback(
      {
        state: query.state,
        code: query.code,
        error: query.error,
        errorDescription: query.error_description,
      },
      "deep-link"
    )
  }
}

const acceptor = new AuthCallbackAcceptor()
export const acceptCallback = (params: AuthCallbackParams, source: AuthCallbackSource) =>
  acceptor.acceptCallback(params, source)
export const acceptPluginAuthCallback = (
  pluginId: string,
  path: string,
  query: Record<string, string>
) => acceptor.acceptPluginCallback(pluginId, path, query)

function callbackPayload(value: unknown): AuthCallbackParams | undefined {
  if (!value || typeof value !== "object") return
  const data = value as Record<string, unknown>
  if (data.__pluginAuth !== true || typeof data.state !== "string" || !data.state) return
  if (typeof data.code !== "string" && typeof data.error !== "string") return
  return {
    state: data.state,
    code: typeof data.code === "string" ? data.code : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
    errorDescription:
      typeof data.error_description === "string" ? data.error_description : undefined,
  }
}

let listenerUsers = 0
let stopListeners: (() => void) | undefined
export function startHostAuthCallbackListeners(): () => void {
  if (typeof window === "undefined") return () => {}
  if (listenerUsers++ === 0) {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const params = callbackPayload(event.data)
      if (params) void acceptCallback(params, "message")
    }
    window.addEventListener("message", onMessage)
    let channel: BroadcastChannel | undefined
    try {
      channel = new BroadcastChannel("plugin-auth")
      channel.onmessage = (event) => {
        const params = callbackPayload(event.data)
        if (params) void acceptCallback(params, "broadcast")
      }
    } catch {
      /* Opener messages remain available on runtimes without channels. */
    }
    stopListeners = () => {
      window.removeEventListener("message", onMessage)
      channel?.close()
    }
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    if (--listenerUsers === 0) {
      stopListeners?.()
      stopListeners = undefined
    }
  }
}

export function registerAuthCallbackWaiter(
  state: string,
  binding: AttemptBinding,
  expiresAt?: number
) {
  const stop = startHostAuthCallbackListeners()
  const waiter = acceptor.registerWaiter(state, binding, expiresAt)
  // Register both branches immediately so cancellation never creates an unhandled rejection.
  const promise = waiter.promise.finally(stop)
  return { promise, cancel: waiter.cancel }
}

/** Host route, intentionally outside the plugin handler registry. */
export function isHostAuthCallback(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === "cognia:" &&
      url.hostname === "auth" &&
      url.pathname === "/callback" &&
      !url.username &&
      !url.password &&
      !url.port
    )
  } catch {
    return false
  }
}
export async function routeHostAuthCallback(raw: string): Promise<boolean> {
  if (!isHostAuthCallback(raw)) return false
  assertRuntimeSupported("auth:callback", currentRuntimeProfile())
  const params = new URL(raw).searchParams
  await acceptCallback(
    {
      state: params.get("state") ?? "",
      code: params.get("code") ?? undefined,
      error: params.get("error") ?? undefined,
      errorDescription: params.get("error_description") ?? undefined,
    },
    "deep-link"
  )
  return true
}
