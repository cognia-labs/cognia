// The speech providers' API keys as this window knows them (ADR-0075): an
// in-memory mirror of the OS keyring on the desktop, or of the web fallback
// store, keyed by `KeyringProviderId`. It loads lazily, on the first playback
// or when the speech settings mount, so the `1 + N` keyring round-trips stay
// off the boot path; the orchestrator reads keys from here so playback does
// not pay an IPC round-trip per chunk. On the desktop a stored key reads as
// `HOST_KEY_PRESENT`: the secret itself stays in the host.
//
// It used to live in the settings store, which owned nothing else of speech's;
// the speech module owns it now (ADR-0250 §14, settings-key ownership).

import { create } from "zustand"
import { isTauri } from "@/lib/tauri"
import {
  clearProviderKey,
  HOST_KEY_PRESENT,
  loadAllProviderKeys,
  setProviderKey,
  type KeyringProviderId,
} from "@/lib/tts/keyring"

export type SpeechProviderKeys = Partial<Record<KeyringProviderId, string>>

interface ProviderKeyState {
  keys: SpeechProviderKeys
  /** Whether a load has completed. */
  loaded: boolean
}

const useProviderKeyStore = create<ProviderKeyState>(() => ({ keys: {}, loaded: false }))

/** React hook: what `select` picks from the keys this window knows. */
export function useSpeechProviderKeys<T>(select: (keys: SpeechProviderKeys) => T): T {
  return useProviderKeyStore((state) => select(state.keys))
}

/** The keys this window knows now; empty until a load completes. */
export function speechProviderKeys(): SpeechProviderKeys {
  return useProviderKeyStore.getState().keys
}

/** Load the keys once. A failed load is retried by the next call; missing keys show in the UI. */
export async function ensureSpeechProviderKeys(): Promise<void> {
  if (useProviderKeyStore.getState().loaded) return
  try {
    useProviderKeyStore.setState({ keys: await loadAllProviderKeys(), loaded: true })
  } catch (err) {
    console.warn("ensureSpeechProviderKeys failed", err)
  }
}

/** Load the keys again, whether or not they have loaded. */
export async function refreshSpeechProviderKeys(): Promise<void> {
  try {
    useProviderKeyStore.setState({ keys: await loadAllProviderKeys(), loaded: true })
  } catch (err) {
    console.warn("refreshSpeechProviderKeys failed", err)
  }
}

/** Store a provider's key; an empty key clears it from this window's mirror. */
export async function setSpeechProviderKey(
  provider: KeyringProviderId,
  key: string
): Promise<void> {
  const trimmed = key.trim()
  await setProviderKey(provider, trimmed)
  useProviderKeyStore.setState((state) => ({
    keys: {
      ...state.keys,
      [provider]: trimmed.length > 0 ? (isTauri() ? HOST_KEY_PRESENT : trimmed) : undefined,
    },
  }))
}

export async function clearSpeechProviderKey(provider: KeyringProviderId): Promise<void> {
  await clearProviderKey(provider)
  useProviderKeyStore.setState((state) => {
    const keys = { ...state.keys }
    delete keys[provider]
    return { keys }
  })
}

/** Test helper: forget every key and the loaded flag. */
export function __resetSpeechProviderKeysForTests(keys: SpeechProviderKeys = {}, loaded = false) {
  useProviderKeyStore.setState({ keys, loaded })
}
