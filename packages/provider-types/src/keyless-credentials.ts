/**
 * Keyless SDK construction.
 *
 * Every `@ai-sdk/*` factory falls back to an environment variable
 * (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, …)
 * when it is given no `apiKey`, and throws before any HTTP when that variable
 * is unset too. For a provider configured without a key — a local engine, an
 * unauthenticated LAN gateway, a relay that authenticates through static
 * headers — both outcomes are wrong: the request either never happens, or it
 * carries an unrelated cloud credential to the configured host.
 *
 * {@link keylessSdkCredential} keeps the ambient fallback only for a request
 * bound for the vendor's own API host, where that variable is meant to be
 * used. Anywhere else it hands the SDK a placeholder (so the factory does not
 * reach for the environment) and a fetch wrapper that removes the header the
 * SDK built from it before the request leaves the process.
 */

export const KEYLESS_SDK_PLACEHOLDER = "cognia-keyless-no-credential"

/** API hosts each SDK's environment-variable fallback belongs to. */
const VENDOR_API_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ["api.openai.com"],
  anthropic: ["api.anthropic.com"],
  google: ["generativelanguage.googleapis.com"],
  gemini: ["generativelanguage.googleapis.com"],
  mistral: ["api.mistral.ai"],
  cohere: ["api.cohere.com", "api.cohere.ai"],
  deepseek: ["api.deepseek.com"],
  perplexity: ["api.perplexity.ai"],
  xai: ["api.x.ai"],
  togetherai: ["api.together.xyz"],
  fireworks: ["api.fireworks.ai"],
  deepinfra: ["api.deepinfra.com"],
  qwen: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
}

const AZURE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
]

function hostOf(baseURL: string): string | undefined {
  try {
    return new URL(baseURL).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * True when an absent key may fall back to the SDK's environment variable: the
 * request goes to that SDK vendor's own API host (or to the SDK default, which
 * is that host).
 */
export function allowsAmbientSdkCredential(input: {
  /** The SDK family whose env var would be read (`openai`, `anthropic`, …). */
  sdk: string
  baseURL?: string
}): boolean {
  const baseURL = input.baseURL?.trim()
  if (!baseURL) return true
  const host = hostOf(baseURL)
  if (!host) return false
  if (input.sdk === "azure") return AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  return (VENDOR_API_HOSTS[input.sdk] ?? []).includes(host)
}

function headerCarriesPlaceholder(value: string): boolean {
  return value.includes(KEYLESS_SDK_PLACEHOLDER)
}

/**
 * Wrap a fetch so any header whose value was built from the placeholder is
 * dropped. Headers the caller configured (a real `Authorization` from
 * `customHeaders`) never contain the placeholder and are left untouched.
 */
export function withKeylessFetch(inner?: typeof globalThis.fetch): typeof globalThis.fetch {
  const base = inner ?? ((input, init) => globalThis.fetch(input, init))
  return (input, init) => {
    const source = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    if (!source) return base(input, init)
    const headers = new Headers(source)
    const placeholders: string[] = []
    headers.forEach((value, name) => {
      if (headerCarriesPlaceholder(value)) placeholders.push(name)
    })
    if (placeholders.length === 0) return base(input, init)
    for (const name of placeholders) headers.delete(name)
    return base(input, { ...init, headers })
  }
}

export interface KeylessSdkCredential {
  /** `apiKey` to pass to the factory; `undefined` keeps the SDK default. */
  apiKey: string | undefined
  /** Replacement fetch when the placeholder is in use; otherwise `inner`. */
  fetch: typeof globalThis.fetch | undefined
}

/**
 * Decide the `apiKey` / `fetch` pair for one SDK factory call. A configured key
 * is passed through unchanged; an absent key keeps the SDK's environment
 * fallback only toward the vendor's own host and is otherwise replaced by the
 * stripped placeholder.
 */
export function keylessSdkCredential(input: {
  sdk: string
  apiKey?: string
  baseURL?: string
  fetch?: typeof globalThis.fetch
}): KeylessSdkCredential {
  const apiKey = input.apiKey?.trim() ? input.apiKey : undefined
  if (apiKey) return { apiKey, fetch: input.fetch }
  if (allowsAmbientSdkCredential({ sdk: input.sdk, baseURL: input.baseURL })) {
    return { apiKey: undefined, fetch: input.fetch }
  }
  return { apiKey: KEYLESS_SDK_PLACEHOLDER, fetch: withKeylessFetch(input.fetch) }
}
