import { LogtoSignInCancelled } from "./capacitor-drivers"
import type { LogtoDrivers } from "./client"

export const LOGTO_CALLBACK_STATE_KEY = "cognia.logto.callback.state"
const STATE_KEY_PREFIX = `${LOGTO_CALLBACK_STATE_KEY}:`
const STATE_TTL_MS = 15 * 60 * 1000
const POPUP_CLOSE_POLL_MS = 200
const POPUP_CLOSE_GRACE_MS = 300

interface LogtoCallbackMessage {
  __cogniaLogto: true
  code: string | null
  state: string | null
  error: string | null
}

const POPUP_NAME = "cognia-logto"
const POPUP_FEATURES = "popup,width=520,height=720"

export interface LogtoWebPopupOptions {
  /**
   * Open the (blank) popup now rather than when the authorize URL is ready.
   *
   * A browser lets a page open a window only while the click that asked for
   * it is still active: Safari ends that at the first network wait, Chrome
   * after about five seconds. Discovery and PKCE come first and can take
   * seconds on their own, so a popup opened at `openUrl` time is often
   * refused. A caller that creates the drivers synchronously inside the click
   * handler passes `true`: the window is reserved while the click still
   * counts, and `openUrl` only points it at the authorize URL. A refused
   * reservation falls back to opening at `openUrl` time.
   */
  reserveWindow?: boolean
  /** Abort waiting, close the popup, and discard this attempt's pending state. */
  signal?: AbortSignal
  /** Poll cadence for user-closed popups; injectable for deterministic tests. */
  closePollMs?: number
  /** Grace delay after `popup.closed` so a racing `postMessage` lands first. */
  closeGraceMs?: number
}

function abortError(): Error {
  const error = new Error("Logto popup wait aborted")
  error.name = "AbortError"
  return error
}

function stateStorageKey(state: string): string {
  return `${STATE_KEY_PREFIX}${state}`
}

function pruneExpiredCallbackStates(now = Date.now()): void {
  try {
    const stale: string[] = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (!key || !key.startsWith(STATE_KEY_PREFIX)) continue
      const expiresAt = Number(window.localStorage.getItem(key))
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        stale.push(key)
      }
    }
    for (const key of stale) {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Storage enumeration failures never block an active flow.
  }
}

export function rememberLogtoCallbackState(state: string, now = Date.now()): void {
  pruneExpiredCallbackStates(now)
  window.localStorage.setItem(stateStorageKey(state), String(now + STATE_TTL_MS))
}

export function forgetLogtoCallbackState(state: string): void {
  window.localStorage.removeItem(stateStorageKey(state))
}

export function hasPendingLogtoCallbackState(state: string, now = Date.now()): boolean {
  const raw = window.localStorage.getItem(stateStorageKey(state))
  if (!raw) return false
  const expiresAt = Number(raw)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function createLogtoWebPopupDrivers(
  fetchImpl?: typeof fetch,
  options: LogtoWebPopupOptions = {}
): LogtoDrivers {
  let reserved: Window | null =
    options.reserveWindow && !options.signal?.aborted
      ? window.open("about:blank", POPUP_NAME, POPUP_FEATURES)
      : null
  let activePopup: Window | null = null
  let pendingState: string | null = null

  const closeWindowsAndForgetState = () => {
    if (reserved && !reserved.closed) reserved.close()
    reserved = null
    if (activePopup && !activePopup.closed) activePopup.close()
    activePopup = null
    if (pendingState) {
      forgetLogtoCallbackState(pendingState)
      pendingState = null
    }
  }

  if (options.signal) {
    if (options.signal.aborted) {
      closeWindowsAndForgetState()
    } else {
      options.signal.addEventListener("abort", closeWindowsAndForgetState, { once: true })
    }
  }

  return {
    fetchImpl,
    openUrl: (url) => {
      if (options.signal?.aborted) {
        closeWindowsAndForgetState()
        throw abortError()
      }
      const state = new URL(url).searchParams.get("state")
      if (!state) throw new Error("Logto authorize URL is missing state")
      rememberLogtoCallbackState(state)
      pendingState = state
      const held = reserved && !reserved.closed ? reserved : null
      reserved = null
      if (held) {
        activePopup = held
        held.location.replace(url)
        return
      }
      const popup = window.open(url, POPUP_NAME, POPUP_FEATURES)
      if (!popup) {
        forgetLogtoCallbackState(state)
        pendingState = null
        throw new Error("Logto popup was blocked")
      }
      activePopup = popup
    },
    abandon: () => {
      closeWindowsAndForgetState()
    },
    waitForCode: ({ state }) =>
      new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          closeWindowsAndForgetState()
          reject(abortError())
          return
        }
        let settled = false
        let graceTimer: ReturnType<typeof setTimeout> | null = null
        const pollMs = options.closePollMs ?? POPUP_CLOSE_POLL_MS
        const graceMs = options.closeGraceMs ?? POPUP_CLOSE_GRACE_MS

        const cleanup = () => {
          settled = true
          window.removeEventListener("message", onMessage)
          options.signal?.removeEventListener("abort", onAbort)
          if (pollTimer !== null) clearInterval(pollTimer)
          if (graceTimer !== null) clearTimeout(graceTimer)
        }

        const onAbort = () => {
          if (settled) return
          cleanup()
          closeWindowsAndForgetState()
          reject(abortError())
        }

        const onMessage = (event: MessageEvent<unknown>) => {
          if (settled) return
          if (event.origin !== window.location.origin || event.source == null) return
          const value = event.data as Partial<LogtoCallbackMessage> | null
          if (!value?.__cogniaLogto) return
          // Another tab or an abandoned earlier popup may post a callback for a
          // different `state`. Ignore it so the active transaction keeps waiting.
          if (value.state !== state) return
          cleanup()
          forgetLogtoCallbackState(state)
          if (pendingState === state) pendingState = null
          activePopup = null
          if (value.error) {
            reject(new Error(`Logto authorization failed: ${value.error}`))
          } else if (!value.code) {
            reject(new Error("Logto callback is missing code"))
          } else {
            resolve({ code: value.code, state })
          }
        }

        const pollTimer =
          pollMs > 0
            ? setInterval(() => {
                if (settled || !activePopup || !activePopup.closed || graceTimer !== null) return
                graceTimer = setTimeout(() => {
                  if (settled) return
                  cleanup()
                  if (pendingState === state) pendingState = null
                  forgetLogtoCallbackState(state)
                  activePopup = null
                  reject(new LogtoSignInCancelled("Logto sign-in window was closed"))
                }, graceMs)
              }, pollMs)
            : null

        window.addEventListener("message", onMessage)
        options.signal?.addEventListener("abort", onAbort, { once: true })
      }),
  }
}

export function readValidatedLogtoCallback(search: string, now = Date.now()): LogtoCallbackMessage {
  pruneExpiredCallbackStates(now)
  const params = new URLSearchParams(search)
  const state = params.get("state")
  if (!state || !hasPendingLogtoCallbackState(state, now)) {
    return { __cogniaLogto: true, code: null, state, error: "state_mismatch" }
  }
  forgetLogtoCallbackState(state)
  return {
    __cogniaLogto: true,
    code: params.get("code"),
    state,
    error: params.get("error"),
  }
}
