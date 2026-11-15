"use client"

import { createLocalKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"

export const NETWORK_PROXY_KEYRING_NAMESPACE = "cognia-network-proxy"
export const NETWORK_PROXY_PASSWORD_KEY = "manual-password"

export type ProxyPasswordMutation =
  { kind: "keep" } | { kind: "replace"; value: string } | { kind: "clear" }

function keyring(): KeyringStore {
  return createLocalKeyringStore(NETWORK_PROXY_KEYRING_NAMESPACE)
}

/** Apply the password editor's explicit keep / replace / clear intent. */
export async function applyProxyPasswordMutation(
  mutation: ProxyPasswordMutation
): Promise<boolean> {
  const store = keyring()
  if (mutation.kind === "keep") {
    return (await store.load(NETWORK_PROXY_PASSWORD_KEY)) !== null
  }
  if (mutation.kind === "clear") {
    await store.delete(NETWORK_PROXY_PASSWORD_KEY)
    if ((await store.load(NETWORK_PROXY_PASSWORD_KEY)) !== null) {
      throw new Error("PROXY_CREDENTIAL_UNAVAILABLE")
    }
    return false
  }

  if (!mutation.value) throw new Error("PROXY_CREDENTIAL_UNAVAILABLE")
  await store.save(NETWORK_PROXY_PASSWORD_KEY, mutation.value)
  const saved = await store.load(NETWORK_PROXY_PASSWORD_KEY)
  if (saved !== mutation.value) throw new Error("PROXY_CREDENTIAL_UNAVAILABLE")
  return true
}
