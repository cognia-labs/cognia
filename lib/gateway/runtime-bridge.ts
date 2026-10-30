/**
 * Internal native gateway commands, shared by desktop and headless brains.
 *
 * This is separate from routing and telemetry: it owns the JSON round-trip
 * between the Rust proxy and existing host privacy/interceptor/model owners.
 * These names are deliberately absent from the public companion RPC catalog.
 */
import {
  hasNoLeakingPii,
  normalizeForRedaction,
  PII_PLACEHOLDER_SOURCE,
  redactText,
} from "@cognia/redact"
import {
  dispatchObserve,
  dispatchTransform,
  type GatewayInterceptorContext,
} from "@/lib/plugin/interceptors"

const COMMANDS = new Set([
  "gateway_privacy_prepare",
  "gateway_middleware_request",
  "gateway_middleware_provider",
  "gateway_middleware_event",
  "gateway_middleware_response",
  "gateway_middleware_usage",
  "gateway_bridge_search",
  "gateway_bridge_vision",
])

const IDENTITY_FIELDS = [
  "requestId",
  "sessionId",
  "ownerAccountId",
  "accountGeneration",
  "protocol",
  "modelAlias",
  "providerId",
  "sourceProviderId",
  "modelId",
  "accountId",
] as const

const PRIVACY_PRESERVED_FIELDS = new Set([
  "model",
  "role",
  "type",
  "id",
  "name",
  "tool_use_id",
  "tool_call_id",
  "media_type",
  "mime_type",
  "file_data",
  "fileData",
  "mimeType",
  "image_url",
  "input_audio",
  "audio",
  "inlineData",
  "inline_data",
])

const MEDIA_BLOCK_TYPES = new Set([
  "image",
  "input_image",
  "audio",
  "input_audio",
  "video",
  "input_video",
])

export interface GatewayPrivacyReplacement {
  placeholder: string
  original: string
}

export function isGatewayRuntimeCommand(command: string): boolean {
  return COMMANDS.has(command)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("gateway_invalid_runtime_payload")
  return value
}

function contextOf(payload: Record<string, unknown>): GatewayInterceptorContext {
  requiredString(payload.requestId)
  if (!Number.isSafeInteger(payload.accountGeneration) || (payload.accountGeneration as number) < 0)
    throw new Error("gateway_invalid_runtime_payload")
  if (payload.ownerAccountId != null) requiredString(payload.ownerAccountId)
  if (payload.sessionId != null) requiredString(payload.sessionId)
  return {
    requestId: payload.requestId as string,
    accountGeneration: payload.accountGeneration as number,
    protocol: typeof payload.protocol === "string" ? payload.protocol : "unknown",
    modelAlias: typeof payload.modelAlias === "string" ? payload.modelAlias : "",
    ...(typeof payload.ownerAccountId === "string"
      ? { ownerAccountId: payload.ownerAccountId }
      : {}),
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
    ...(typeof payload.providerId === "string" ? { providerId: payload.providerId } : {}),
    ...(typeof payload.modelId === "string" ? { modelId: payload.modelId } : {}),
  }
}

/** Recheck before sending and before publishing any result into the active DB. */
async function assertAuthority(context: GatewayInterceptorContext): Promise<void> {
  const [{ gatewayGetStatus }, { getActiveAccountId }] = await Promise.all([
    import("@/lib/tauri/gateway"),
    import("@/lib/accounts/active-account-id"),
  ])
  const status = await gatewayGetStatus()
  if (
    status.accountGeneration !== context.accountGeneration ||
    (context.ownerAccountId &&
      (context.ownerAccountId !== getActiveAccountId() ||
        (status.ownerAccountId && status.ownerAccountId !== context.ownerAccountId)))
  ) {
    throw new Error("gateway_account_changed")
  }
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const entry of Object.values(value)) freezeTree(entry)
  }
  return value
}

function maskBody(body: Record<string, unknown>): {
  body: Record<string, unknown>
  replacements: GatewayPrivacyReplacement[]
} {
  const originalJson = JSON.stringify(body)
  const replacements: GatewayPrivacyReplacement[] = []
  let counter = 1
  const walk = (value: unknown, field?: string): unknown => {
    if (field && PRIVACY_PRESERVED_FIELDS.has(field)) return value
    if (object(value) && typeof value.type === "string" && MEDIA_BLOCK_TYPES.has(value.type))
      return value
    if (typeof value === "string") {
      // Canonical redactText starts its counter at one for each text. Hide
      // literal placeholders while it runs so an existing token is never
      // mistaken for a new replacement in this field.
      let prefix = "__COGNIA_LITERAL_"
      while (value.includes(prefix)) prefix = `_${prefix}`
      const literals: string[] = []
      const escaped = normalizeForRedaction(value).replace(
        new RegExp(PII_PLACEHOLDER_SOURCE, "g"),
        (literal) => {
          literals.push(literal)
          return `${prefix}${literals.length - 1}__`
        }
      )
      const result = redactText(escaped)
      let masked = result.redacted.replace(
        new RegExp(PII_PLACEHOLDER_SOURCE, "g"),
        (placeholder) => {
          const record = result.map[placeholder]
          if (!record) return placeholder
          let unique: string
          do {
            unique = `<${record.kind}_${String(counter++).padStart(3, "0")}>`
          } while (originalJson.includes(unique))
          replacements.push({ placeholder: unique, original: record.original })
          return unique
        }
      )
      literals.forEach((literal, index) => {
        masked = masked.replace(`${prefix}${index}__`, literal)
      })
      return masked
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry))
    if (object(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, walk(entry, key)])
      )
    return value
  }
  return { body: walk(body) as Record<string, unknown>, replacements }
}

async function middleware(
  command: string,
  payload: Record<string, unknown>,
  context: GatewayInterceptorContext
): Promise<Record<string, unknown>> {
  const dispatchContext = {
    operationId: `gateway:${context.requestId}`,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    deadlineBudgetMs: command === "gateway_middleware_event" ? 1_000 : 2_000,
  }
  // A plugin receives a snapshot, never the native bridge's mutable identity.
  const input = freezeTree(structuredClone(payload))
  if (command === "gateway_middleware_usage") {
    dispatchObserve("gateway.usage.recorded", input, dispatchContext)
    return { recorded: true }
  }
  const point = {
    gateway_middleware_request: "gateway.request.prepare",
    gateway_middleware_provider: "gateway.provider.prepare",
    gateway_middleware_event: "gateway.stream.transform",
    gateway_middleware_response: "gateway.response.transform",
  }[command]
  if (!point) throw new Error("gateway_unknown_runtime_command")
  const transformed = await dispatchTransform(point, input, {
    ...dispatchContext,
    invariantFields: IDENTITY_FIELDS,
  })
  const value = transformed.value
  if (!object(value)) throw new Error("gateway_invalid_runtime_payload")
  // A deep-frozen input also prevents in-place mutation from evading the
  // dispatcher's scalar invariant comparison; this final check covers output.
  for (const field of IDENTITY_FIELDS) {
    if (value[field] !== payload[field]) throw new Error(`gateway_identity_changed:${field}`)
  }
  await assertAuthority(context)
  if (command === "gateway_middleware_event") {
    if (typeof value.event !== "string" || value.data == null)
      throw new Error("gateway_invalid_stream_event")
    return { event: value.event, data: value.data }
  }
  if (!object(value.body)) throw new Error("gateway_invalid_runtime_body")
  return { body: value.body }
}

function safeText(value: unknown): string {
  const text = requiredString(value)
  const maxPromptBytes = 64 * 1024
  if (text.length > maxPromptBytes || new TextEncoder().encode(text).byteLength > maxPromptBytes)
    throw new Error("gateway_bridge_prompt_too_large")
  if (!hasNoLeakingPii(text)) throw new Error("gateway_bridge_pii_blocked")
  return text
}

function inlineImages(value: unknown): Array<{ image: Uint8Array; mediaType: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    throw new Error("gateway_bridge_inline_images_required")
  let bytes = 0
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(entry)
    )
      throw new Error("gateway_bridge_inline_images_required")
    const encoded = entry.slice(entry.indexOf(",") + 1)
    if (encoded.length === 0 || encoded.length % 4 !== 0)
      throw new Error("gateway_bridge_inline_images_required")
    bytes += Math.floor((encoded.length * 3) / 4)
    if (bytes > 20 * 1024 * 1024) throw new Error("gateway_bridge_images_too_large")
    return {
      image: Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
      mediaType: entry.slice("data:".length, entry.indexOf(";")),
    }
  })
}

interface NativeBridgeLease {
  baseUrl: string
  secret: string
  modelId: string
  credentialHash: string
}

function nativeLeaseOf(
  payload: Record<string, unknown>,
  modelId: string
): NativeBridgeLease | null {
  if (payload.nativeLease === undefined) return null
  const lease = payload.nativeLease
  if (!object(lease)) throw new Error("gateway_invalid_native_lease")
  let endpoint: URL
  try {
    endpoint = new URL(requiredString(lease.baseUrl))
  } catch {
    throw new Error("gateway_invalid_native_lease")
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    !["/v1", "/v1/"].includes(endpoint.pathname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    lease.modelId !== modelId ||
    typeof lease.secret !== "string" ||
    !lease.secret ||
    lease.secret.length > 1_024 ||
    typeof lease.credentialHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(lease.credentialHash) ||
    lease.credentialHash !== payload.expectedCredentialHash
  )
    throw new Error("gateway_invalid_native_lease")
  return lease as unknown as NativeBridgeLease
}

async function credentialHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function modelBridge(
  command: string,
  payload: Record<string, unknown>,
  context: GatewayInterceptorContext
): Promise<Record<string, unknown>> {
  const providerId = requiredString(payload.sourceProviderId ?? context.providerId)
  const modelId = requiredString(context.modelId)
  const nativeLease = nativeLeaseOf(payload, modelId)
  const resolutionProviderId = nativeLease ? "cognia-gateway-internal-bridge" : providerId
  const feature = command === "gateway_bridge_search" ? "search" : "vision"
  const prompt = safeText(feature === "search" ? payload.query : payload.prompt)
  const images = feature === "vision" ? inlineImages(payload.images) : []
  const [
    { getSettings },
    provider,
    { beginLedgeredGeneration, usageOfResult },
    { generateText },
    { recordSurfaceUsage, swallowUsageWrite },
    streaming,
  ] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/lib/ai/provider-consumption"),
    import("@/lib/ai/ledgered-model-call"),
    import("ai"),
    import("@/lib/db/session-usage"),
    import("@/lib/runtime/streaming-fetch"),
  ])
  const settings = await getSettings()
  let transientSettings = settings
  if (nativeLease) {
    // Only the native owner can issue this one-use ticket. Original provider
    // credentials stay in Rust; no fallback or unrelated settings are read.
    transientSettings = {
      ...settings,
      providerSettings: {},
      customProviders: [
        {
          id: resolutionProviderId,
          providerId: resolutionProviderId,
          name: resolutionProviderId,
          isCustom: true,
          customName: "Cognia gateway internal bridge",
          customModels: [modelId],
          models: [],
          enabled: true,
          apiProtocol: "openai",
          apiFlavor: "chat",
          baseURL: nativeLease.baseUrl,
          apiKey: nativeLease.secret,
          defaultModel: modelId,
        },
      ],
    }
  } else if (payload.accountId != null) {
    const accountId = requiredString(payload.accountId)
    const { resolveSubscriptionProviderCredential } =
      await import("@/lib/claude/provider-attempt-options")
    const credential = await resolveSubscriptionProviderCredential(providerId, settings, accountId)
    if (!credential) throw new Error("gateway_bridge_credentials_unavailable")
    transientSettings = {
      ...settings,
      providerSettings: {
        ...settings.providerSettings,
        [providerId]: {
          ...settings.providerSettings?.[providerId],
          providerId,
          defaultModel: modelId,
          enabled: settings.providerSettings?.[providerId]?.enabled ?? true,
          apiKey: credential.apiKey,
          baseURL: credential.baseURL,
          customHeaders: credential.headers,
          ...(credential.protocol ? { apiProtocol: credential.protocol } : {}),
          ...(credential.apiFlavor ? { apiFlavor: credential.apiFlavor } : {}),
        },
      },
      customProviders: settings.customProviders?.map((entry) =>
        entry.id === providerId
          ? {
              ...entry,
              apiKey: credential.apiKey,
              baseURL: credential.baseURL,
              customHeaders: credential.headers,
              ...(credential.protocol ? { protocol: credential.protocol } : {}),
              ...(credential.apiFlavor ? { apiFlavor: credential.apiFlavor } : {}),
            }
          : entry
      ),
    }
  }
  const snapshot = provider.createProviderSettingsSnapshot({
    defaultProvider: resolutionProviderId,
    providerSettings: transientSettings.providerSettings,
    customProviders: transientSettings.customProviders,
  })
  const resolved = provider.resolveFeatureProvider(
    {
      featureId: `gateway-${feature}`,
      routeProfile: feature === "vision" ? "vision" : "general-text",
      selectionMode: "explicit-provider",
      providerId: resolutionProviderId,
      fallbackMode: "none",
    },
    snapshot
  )
  if (resolved.kind !== "resolved") throw new Error("gateway_bridge_credentials_unavailable")
  if (
    !nativeLease &&
    payload.expectedCredentialHash !== undefined &&
    (typeof payload.expectedCredentialHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.expectedCredentialHash) ||
      (await credentialHash(resolved.apiKey ?? "")) !== payload.expectedCredentialHash)
  ) {
    throw new Error("gateway_bridge_credential_changed")
  }
  let modelFetch: typeof fetch
  if (nativeLease) {
    const { proxyFetch } = await import("@/lib/network/proxy-fetch")
    modelFetch = (input, init) => proxyFetch(input, { ...init, timeout: 60_000 })
  } else {
    modelFetch = streaming.getStreamingFetch()
  }
  const model = provider.createFeatureProviderModel(
    { ...resolved, model: modelId },
    {
      fetch: modelFetch,
      headers: streaming.browserDirectHeaders(resolved.protocol),
    }
  )
  let searchResult: unknown
  let finalPrompt = prompt
  if (feature === "search") {
    const { searchWithSettings } = await import("@/lib/search/configured-search-core")
    const maxResults = payload.maxResults === undefined ? 5 : payload.maxResults
    if (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > 20)
      throw new Error("gateway_invalid_runtime_payload")
    await assertAuthority(context)
    searchResult = await searchWithSettings(prompt, {
      settings,
      options: { maxResults: maxResults as number },
      scope: context.ownerAccountId ?? "gateway",
      signal: AbortSignal.timeout(60_000),
    })
    // Search results are untrusted source text. The canonical gate is applied
    // again before synthesis; credentials and request metadata never enter it.
    const { wrapUntrustedContent } = await import("@/lib/web/untrusted-content")
    finalPrompt = `Answer the query using the search results. Cite source URLs.\nQuery: ${prompt}\n${wrapUntrustedContent(redactText(JSON.stringify(searchResult)).redacted)}`
    safeText(finalPrompt)
  }
  await assertAuthority(context)
  const lease = await beginLedgeredGeneration({
    binding: {
      surface: "utilityLedger",
      origin: "utility",
      featureId: `gateway-${feature}`,
      providerId,
      modelId,
      workspaceId: null,
    },
    prompt: finalPrompt,
    maxOutputTokens: 2_048,
    settings,
  })
  const started = Date.now()
  let result: Awaited<ReturnType<typeof generateText>>
  try {
    await assertAuthority(context)
    result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: finalPrompt },
            ...images.map(({ image, mediaType }) => ({
              type: "file" as const,
              data: { type: "data" as const, data: image },
              mediaType,
            })),
          ],
        },
      ],
      maxOutputTokens: 2_048,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
      ...lease?.options,
    })
    await lease?.succeeded(usageOfResult(result.usage, result.providerMetadata))
  } catch (error) {
    await lease?.failed(error)
    throw error
  }
  await assertAuthority(context)
  if (!result.text.trim()) throw new Error("gateway_bridge_empty_response")
  const tokens = usageOfResult(result.usage, result.providerMetadata)
  if (!nativeLease)
    swallowUsageWrite(
      recordSurfaceUsage({
        surface: "gateway",
        operationId: `bridge:${context.requestId}:${feature}`,
        scopeId: context.sessionId ?? context.requestId,
        usage: {
          inputTokens: tokens?.inputTokens ?? 0,
          outputTokens: tokens?.outputTokens ?? 0,
          cacheReadTokens: tokens?.cacheReadTokens,
          cacheCreationTokens: tokens?.cacheWriteTokens,
          providerId,
          model: modelId,
          durationMs: Date.now() - started,
          usageBasis: "provider-reported",
        },
      })
    )
  return {
    text: result.text,
    usage: {
      inputTokens: tokens?.inputTokens ?? 0,
      outputTokens: tokens?.outputTokens ?? 0,
      cacheReadTokens: tokens?.cacheReadTokens ?? 0,
      cacheWriteTokens: tokens?.cacheWriteTokens ?? 0,
    },
    ...(searchResult ? { search: searchResult } : {}),
  }
}

export async function dispatchGatewayRuntimeCommand(
  command: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!isGatewayRuntimeCommand(command)) throw new Error("gateway_unknown_runtime_command")
  const context = contextOf(payload)
  await assertAuthority(context)
  if (command === "gateway_privacy_prepare") {
    if (!object(payload.body)) throw new Error("gateway_invalid_runtime_body")
    return maskBody(payload.body)
  }
  if (command.startsWith("gateway_middleware_")) return middleware(command, payload, context)
  return modelBridge(command, payload, context)
}
