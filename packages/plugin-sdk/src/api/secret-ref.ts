import type { PluginCredentialRef } from "@cognia/plugin-contract/types/plugin/plugin"

/** Reference a stored secret without reading it into plugin request data. */
export function secretRef(key: string, options?: { prefix?: string }): PluginCredentialRef {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("secretRef requires a non-empty secret key")
  }
  if (options?.prefix !== undefined && typeof options.prefix !== "string") {
    throw new Error("secretRef prefix must be a string")
  }
  return Object.defineProperty(
    { $secretRef: key, ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}) },
    Symbol.for("cognia.plugin.secretRef"),
    { value: true }
  )
}
