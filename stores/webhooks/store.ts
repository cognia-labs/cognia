/**
 * Canonical Standard Webhooks settings store.
 *
 * This is intentionally outbound-only. The removed Remote Control listener
 * no longer owns renderer state or Tauri commands; webhook delivery keeps its
 * non-secret configuration here and stores the signing secret through the
 * shared keyring abstraction.
 */

import { loggers } from "@cognia/logging"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { setWebhookSigningSecret } from "@/lib/webhooks/signing-secret"
import { persistLocalStorage } from "@/stores/persist-storage"
import {
  DEFAULT_WEBHOOK_CONFIG,
  normalizeWebhookDelivery,
  type WebhookConfig,
  type WebhookEndpoint,
  type WebhookHeader,
} from "@/types/webhooks"

const log = loggers.scheduler

interface WebhookState {
  config: WebhookConfig
  lastError: string | null
}

interface WebhookActions {
  updateConfig: (patch: Partial<WebhookConfig>) => Promise<{ ok: boolean; error?: string }>
  setDefaultHeaders: (headers: WebhookHeader[]) => Promise<{ ok: boolean; error?: string }>
  setSigningSecret: (secret: string | null) => Promise<{ ok: boolean; error?: string }>
  reset: () => void
}

type WebhookStore = WebhookState & WebhookActions

function cloneEndpoint(endpoint: WebhookEndpoint): WebhookEndpoint {
  return {
    ...endpoint,
    headers: endpoint.headers.map((header) => ({ ...header })),
    eventTypes: endpoint.eventTypes ? [...endpoint.eventTypes] : undefined,
  }
}

function cloneConfig(config: WebhookConfig): WebhookConfig {
  return {
    hasSigningSecret: config.hasSigningSecret,
    defaultHeaders: config.defaultHeaders.map((header) => ({ ...header })),
    endpoints: config.endpoints.map(cloneEndpoint),
    delivery: normalizeWebhookDelivery(config.delivery),
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const initialConfig = cloneConfig(DEFAULT_WEBHOOK_CONFIG)

export const useWebhookStore = create<WebhookStore>()(
  persist(
    (set, get) => ({
      config: initialConfig,
      lastError: null,

      updateConfig: async (patch) => {
        const next = cloneConfig({ ...get().config, ...patch })
        set({ config: next, lastError: null })
        return { ok: true }
      },

      setDefaultHeaders: async (headers) => get().updateConfig({ defaultHeaders: headers }),

      setSigningSecret: async (secret) => {
        const normalized = secret && secret.length > 0 ? secret : null
        try {
          await setWebhookSigningSecret(normalized)
          set((state) => ({
            config: { ...state.config, hasSigningSecret: normalized !== null },
            lastError: null,
          }))
          return { ok: true }
        } catch (error) {
          const message = describeError(error)
          log.error("webhooks.setSigningSecret failed", { error: message })
          set({ lastError: message })
          return { ok: false, error: message }
        }
      },

      reset: () => set({ config: cloneConfig(initialConfig), lastError: null }),
    }),
    {
      name: "cognia-remote-control",
      storage: persistLocalStorage(),
      version: 1,
      partialize: (state) => ({ config: state.config }),
    }
  )
)

export const selectWebhookConfig = (state: WebhookStore) => state.config
