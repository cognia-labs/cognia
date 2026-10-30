/**
 * Mint the session-scoped route ticket a gateway-routed execution spec needs
 * (ADR-0090 Phase 2).
 *
 * Everything around this existed already and did nothing: the Rust commands,
 * the `gatewayAgentRouteTickets` flag, `sendSpecFromResolved`'s `gateway`
 * parameter, the settings panel that lists and revokes tickets, and the
 * sidecar's `validateRouteEnv` invariant. What was missing was an issuer — no
 * call site anywhere reached `gatewayMintRouteTicket`, so `route.kind` resolved
 * to `"gateway"` and then silently degraded to `direct` on the wire, and the
 * ticket list could never be anything but empty.
 *
 * The secret is returned ONCE and is never persisted: the caller stamps it into
 * `SendOptions.env.ANTHROPIC_API_KEY` alongside `ANTHROPIC_BASE_URL` (the
 * endpoint), which is exactly the shape `sidecar/dispatch/subprocess-env.mjs`
 * validates.
 */

import { contentDigest } from "@cognia/agent"
import type { GatewayTaskBudget, GatewayTaskModelPlan } from "@/types/gateway"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { captureRemoteGatewayTarget, acquireRemoteTaskLease } from "./remote-task-lease"
import { getAllProviders } from "@cognia/provider-types/provider"
import { resolveProviderProtocol } from "@cognia/provider-types/provider-protocol"
import { isAgentExecutionFlagEnabled } from "@/lib/ai/agent/execution/feature-flags"
import { isHeadlessHost } from "@/lib/platform/detect"
import {
  gatewayGetStatus,
  gatewayGetConfig,
  gatewayMintRouteTicket,
  gatewayPushSnapshot,
  gatewayRevokeRouteTicket,
  gatewayStart,
} from "@/lib/tauri/gateway"
import type { GatewayRoutingSnapshot, GatewayModelMetadata } from "@/types/gateway"

export interface MintSessionTicketInput {
  sessionId: string
  parentSessionId?: string
  executionFingerprint: string
  /** The model the turn will ask for — decides which candidates are frozen. */
  model: string
  routePolicy: string
}

export interface MintedSessionTicket {
  /** OpenAI-compatible base URL of the local listener. */
  endpoint: string
  ticketId: string
  /** Shown once. Stamp into the subprocess env and drop. */
  secret: string
}

/**
 * Candidates the gateway can actually serve for `model`, ordered.
 *
 * Mint rejects any candidate the current snapshot cannot serve
 * (`TicketError::UnknownCandidate`), so this resolves against the same
 * snapshot the provider publishes rather than guessing. An alias contributes
 * its ordered entries; a bare / `provider:model` id falls back to whichever
 * enabled providers list it.
 */
export function candidatesForModel(
  snapshot: GatewayRoutingSnapshot,
  model: string
): Array<{ deploymentId: string; modelId: string }> {
  const deploymentFor = (providerId: string): string | undefined =>
    snapshot.providers.find((provider) => provider.id === providerId)?.deploymentId ?? providerId

  const alias = snapshot.aliases.find((entry) => entry.alias === model)
  if (alias) {
    return alias.entries.flatMap((entry) => {
      const deploymentId = deploymentFor(entry.providerId)
      return deploymentId ? [{ deploymentId, modelId: entry.modelId }] : []
    })
  }

  // Match the longest registered prefix: plugin provider ids themselves
  // contain colons, and a model id may contain them too.
  const pinned = snapshot.providers
    .filter((provider) => model.startsWith(`${provider.id}:`))
    .sort((a, b) => b.id.length - a.id.length)[0]
  const bareModel = pinned ? model.slice(pinned.id.length + 1) : model
  return snapshot.providers.flatMap((provider) => {
    if (!provider.enabled || (pinned && provider.id !== pinned.id)) return []
    if (!provider.models.includes(bareModel)) return []
    return [{ deploymentId: provider.deploymentId ?? provider.id, modelId: bareModel }]
  })
}

/** `loopback` binds 127.0.0.1; `lan` still answers there, so both dial local. */
function endpointFor(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

/**
 * Returns `undefined` — never throws — when a ticket cannot be minted: the flag
 * is off, the listener is not running, the snapshot cannot serve the model, or
 * Rust refused. The caller then sends the `direct` wire shape, which is the
 * pre-existing behavior. Failing the whole turn over an optional route freeze
 * would be a worse trade.
 */
export async function mintSessionRouteTicket(
  input: MintSessionTicketInput
): Promise<MintedSessionTicket | undefined> {
  if (!isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")) return undefined

  try {
    const status = await gatewayGetStatus()
    if (!status.running || status.boundPort === null) return undefined

    const { buildGatewaySnapshot, loadSnapshotProfileMeta } =
      await import("@/lib/gateway/snapshot-publisher")
    const { useSettingsStore } = await import("@/stores/settings")
    const live = useSettingsStore.getState().settings
    if (!live) return undefined

    const profileMeta = await loadSnapshotProfileMeta().catch(() => undefined)
    const snapshot = buildGatewaySnapshot(
      {
        defaultProvider: live.defaultProvider,
        providerSettings: live.providerSettings,
        customProviders: live.customProviders,
        modelMappings: live.modelMappings,
        routingConfig: live.routingConfig,
      },
      Date.now(),
      profileMeta
    )

    const candidates = candidatesForModel(snapshot, input.model)
    if (candidates.length === 0) return undefined

    const minted = await gatewayMintRouteTicket({
      sessionId: input.sessionId,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      executionFingerprint: input.executionFingerprint,
      candidates,
      // No `modelBindings` on purpose: Rust's `default_model_bindings` binds
      // `primary` and the sonnet/haiku/opus family selectors from `model`, so
      // there is exactly one implementation of that mapping. Claude Code's
      // first background (haiku) turn used to 400 because nothing bound it.
      model: input.model,
      // More than one candidate means failover is possible, so the ticket must
      // permit moving off the first credential; a single candidate stays stuck
      // to its own.
      credentialAffinity: candidates.length > 1 ? "sticky-with-failover" : "session-sticky",
      allowAuthFailover: candidates.length > 1,
      routePolicy: input.routePolicy,
    })

    return {
      endpoint: endpointFor(status.boundPort),
      ticketId: minted.ticket.ticketId,
      secret: minted.secret,
    }
  } catch {
    return undefined
  }
}

export interface ExternalAgentGatewayRouteInput {
  providerId: string
  modelId: string
  modelPlan?: GatewayTaskModelPlan
  accountId?: string | null
  sessionId: string
  executionFingerprint?: string
  ingressProtocol?: "openai-chat" | "openai-responses" | "anthropic"
  /**
   * The paired device a Host-run turn is for. The headless lease is scoped to
   * it, so another device can neither renew nor reuse the task's route.
   */
  originDeviceId?: string | null
  /**
   * Optional consumption ceiling on the task's ticket (a Bot run's remaining
   * token allowance under its cost cap). Absent means unmetered.
   */
  budget?: GatewayTaskBudget
  signal?: AbortSignal
}

/**
 * The headless brain's route (ADR-0090, 2026-10-02): its providers live in the
 * server's Provider Profile Store, so `cognia-server` mints the lease from the
 * snapshot its own gateway serves and no credential ever reaches this process.
 */
async function prepareHostGatewayRoute(input: ExternalAgentGatewayRouteInput) {
  // Profile-store providers carry one Host credential each; there is no vault
  // account to pin, and silently ignoring an explicit pick would run the task
  // on a credential the caller did not choose.
  if (
    (typeof input.accountId === "string" && input.accountId) ||
    Object.values(input.modelPlan?.bindings ?? {}).some(
      (binding) => typeof binding.accountId === "string" && binding.accountId
    )
  )
    throw new Error("This Host's Cognia providers have no selectable accounts")
  const { acquireHostTaskLease } = await import("./host-task-lease")
  const lease = await acquireHostTaskLease({
    taskId: input.sessionId,
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.modelPlan ? { modelPlan: input.modelPlan } : {}),
    ingressProtocol: input.ingressProtocol ?? "openai-chat",
    originDeviceId: input.originDeviceId ?? null,
    ...(input.budget ? { budget: input.budget } : {}),
    signal: input.signal,
  })
  return {
    endpoint: lease.endpoint,
    ticketId: lease.ticketId,
    secret: lease.secret,
    model: input.modelId,
    modelMetadata: lease.modelMetadata,
    modelMetadataById: lease.modelMetadataById,
    ownerAccountId: lease.ownerAccountId,
    binding: { providerId: input.providerId, modelId: input.modelId, accountId: null },
    revoke: lease.revoke,
    signal: lease.signal,
    assertCurrent: lease.assertCurrent,
  }
}

/**
 * Prepare a required, task-isolated gateway lease. The ordinary snapshot is
 * published first; an explicitly selected account lives only in the ticket's
 * private provider override and never changes another task's account.
 */
export async function prepareExternalAgentGatewayRoute(
  input: ExternalAgentGatewayRouteInput
): Promise<
  MintedSessionTicket & {
    model: string
    modelMetadata: GatewayModelMetadata
    modelMetadataById: Record<string, GatewayModelMetadata>
    ownerAccountId: string | null
    binding: { providerId: string; modelId: string; accountId: string | null }
    revoke?: () => Promise<void>
    signal?: AbortSignal
    assertCurrent?: () => void
  }
> {
  if (!input.providerId.trim() || !input.modelId.trim() || !input.sessionId.trim())
    throw new Error("A provider, model and task session are required for the Cognia gateway")
  if (isHeadlessHost()) return prepareHostGatewayRoute(input)
  const remoteScope = getActiveRemoteTransport() ? captureRemoteGatewayTarget() : undefined
  const [
    { useSettingsStore },
    { useAccountStore },
    publisher,
    { resolveSubscriptionProviderCredential },
  ] = await Promise.all([
    import("@/stores/settings"),
    import("@/stores/account/account-store"),
    import("@/lib/gateway/snapshot-publisher"),
    import("@/lib/claude/provider-attempt-options"),
  ])
  const settings = useSettingsStore.getState().settings
  if (!settings) throw new Error("Cognia provider settings are unavailable")
  const ownerAccountId = useAccountStore.getState().unlockedAccountId
  // Only the inputs this route is built from; unrelated settings writes (theme,
  // usage stats) replace the settings object and must not revoke the task.
  const routeInputs = (value: typeof settings | null | undefined) =>
    value
      ? JSON.stringify([
          [
            ...new Set([
              input.providerId,
              ...Object.values(input.modelPlan?.bindings ?? {}).map(
                (binding) => binding.providerId
              ),
            ]),
          ]
            .sort()
            .map((id) => [
              id,
              value.providerSettings?.[id],
              value.customProviders?.find((provider) => provider.id === id),
            ]),
          value.defaultProvider,
          value.defaultAccountId,
          value.defaultAccountIds,
        ])
      : null
  const settingsInputs = routeInputs(settings)
  let authorityChanged = false
  let transferredAuthority = false
  const authorityListeners = new Set<() => void>()
  const invalidateAuthority = () => {
    authorityChanged = true
    for (const listener of authorityListeners) listener()
  }
  const unsubscribeAccount = remoteScope
    ? useAccountStore.subscribe((next, prior) => {
        if (
          next.unlockedAccountId !== prior.unlockedAccountId ||
          next.locked !== prior.locked ||
          next.activeAccountId !== prior.activeAccountId
        )
          invalidateAuthority()
      })
    : undefined
  const unsubscribeSettings = remoteScope
    ? useSettingsStore.subscribe((next, prior) => {
        if (next.settings !== prior.settings && routeInputs(next.settings) !== settingsInputs)
          invalidateAuthority()
      })
    : undefined
  const releaseAuthority = () => {
    unsubscribeAccount?.()
    unsubscribeSettings?.()
    authorityListeners.clear()
  }
  try {
    const assertCurrent = () => {
      remoteScope?.assertCurrent()
      input.signal?.throwIfAborted()
      if (
        authorityChanged ||
        useAccountStore.getState().unlockedAccountId !== ownerAccountId ||
        (remoteScope
          ? routeInputs(useSettingsStore.getState().settings) !== settingsInputs
          : useSettingsStore.getState().settings !== settings)
      )
        throw new Error("Cognia account or model settings changed while preparing the task")
    }
    assertCurrent()
    let status = remoteScope ? undefined : await gatewayGetStatus()
    if (status?.accountRequired && (!ownerAccountId || status.ownerAccountId !== ownerAccountId))
      throw new Error("Unlock the Cognia account before starting the gateway task")
    const accountGeneration = status?.accountGeneration
    if (!remoteScope && !status?.running) {
      await gatewayStart()
      status = await gatewayGetStatus()
    }
    assertCurrent()
    if (!remoteScope && (!status?.running || status.boundPort === null))
      throw new Error("The Cognia gateway listener is unavailable")
    if (
      !remoteScope &&
      (status?.accountGeneration !== accountGeneration ||
        (status?.accountRequired && status.ownerAccountId !== ownerAccountId))
    )
      throw new Error("Cognia account changed while starting the gateway")
    const profileMeta = await publisher.loadSnapshotProfileMeta()
    const snapshot = await publisher.buildEnrichedGatewaySnapshot(settings, Date.now(), profileMeta)
    assertCurrent()
    const { getSubscriptionProvider } = await import("@/lib/subscription/core/provider-registry")
    const gatewayConfig = await gatewayGetConfig()
    assertCurrent()
    const bridgeBindings: NonNullable<GatewayTaskModelPlan["bindings"]> = {}
    if (gatewayConfig.bridgeModels) {
      for (const selector of Object.values(gatewayConfig.bridgeModels ?? {})) {
        if (!selector?.trim()) continue
        const target = candidatesForModel(snapshot, selector).find((candidate) =>
          snapshot.providers.some(
            (provider) =>
              (provider.deploymentId ?? provider.id) === candidate.deploymentId &&
              provider.enabled &&
              provider.models.includes(candidate.modelId)
          )
        )
        const provider =
          target &&
          snapshot.providers.find(
            (provider) => (provider.deploymentId ?? provider.id) === target.deploymentId
          )
        if (!provider || !target)
          throw new Error(`The configured gateway bridge model ${selector} is unavailable`)
        if (selector === input.modelId || input.modelPlan?.additionalModels.includes(selector))
          throw new Error("A gateway bridge selector conflicts with a task model selector")
        bridgeBindings[selector] = {
          providerId: provider.id,
          modelId: target.modelId,
          ...(provider.id === input.providerId ? { accountId: input.accountId } : {}),
        }
      }
    }
    const effectivePlan: GatewayTaskModelPlan | undefined = Object.keys(bridgeBindings).length
      ? {
          additionalModels: [
            ...(input.modelPlan?.additionalModels ?? []),
            ...Object.keys(bridgeBindings),
          ],
          modelBindings: {
            ...input.modelPlan?.modelBindings,
            ...Object.fromEntries(
              Object.entries(bridgeBindings).map(([selector, binding]) => [
                selector,
                binding.modelId,
              ])
            ),
          },
          bindings: { ...input.modelPlan?.bindings, ...bridgeBindings },
        }
      : input.modelPlan
    const requested = [input.modelId, ...(effectivePlan?.additionalModels ?? [])]
    if (new Set(requested).size !== requested.length || requested.length > 32)
      throw new Error("The task model plan contains duplicate models or exceeds its limit")
    const modelMetadataById: Record<string, GatewayModelMetadata> = Object.create(null)
    const taskProviders = new Map<string, GatewayRoutingSnapshot["providers"][number]>()
    const selectorDeployments: Record<string, string> = Object.create(null)
    let providerAccountId: string | null | undefined
    for (const selector of requested) {
      const selected = effectivePlan?.bindings?.[selector] ?? {
        providerId: input.providerId,
        modelId: effectivePlan?.modelBindings[selector] ?? selector,
        accountId: input.accountId,
      }
      if (!selected.providerId.trim() || !selected.modelId.trim())
        throw new Error("Each task model requires a provider and concrete model")
      const definition = getSubscriptionProvider(selected.providerId, settings.customProviders)
      const configured =
        settings.customProviders?.find((entry) => entry.id === selected.providerId) ??
        settings.providerSettings?.[selected.providerId]
      const provider = snapshot.providers.find((entry) => entry.id === selected.providerId)
      if (!provider || provider.credentialFallbackAllowed === false)
        throw new Error(
          `The selected Cognia provider ${selected.providerId} is unavailable or disabled`
        )
      const allowsUnauthenticated = getAllProviders()[selected.providerId]?.apiKeyRequired === false
      const hasManualCredential = Boolean(
        configured?.apiKey?.trim() ||
        configured?.apiKeys?.some((key) => key.trim()) ||
        (!definition && (provider.apiKey?.trim() || provider.apiKeys?.some((key) => key.trim())))
      )
      let accountId = selected.accountId
      if (accountId === undefined) {
        if (hasManualCredential) accountId = null
        else if (definition && definition.authMode !== "anthropic-oauth") {
          const { getActiveAccount } = await import("@/lib/subscription/core/transport")
          accountId =
            settings.defaultAccountIds?.[definition.id] ??
            (settings.defaultProvider === selected.providerId ||
            settings.defaultProvider === definition.id
              ? settings.defaultAccountId
              : undefined) ??
            (await getActiveAccount(definition.id)).activeAccountId
        } else accountId = null
      }
      assertCurrent()
      if (!accountId && !hasManualCredential && !allowsUnauthenticated)
        throw new Error(`The selected Cognia model ${selector} has no usable gateway credential`)
      if (selector === input.modelId) providerAccountId = accountId
      let upstream = { ...provider }
      if (accountId) {
        const credential = await resolveSubscriptionProviderCredential(
          selected.providerId,
          settings,
          accountId
        )
        assertCurrent()
        if (!credential)
          throw new Error(`The selected Cognia subscription account is unavailable for ${selector}`)
        const protocol = credential.protocol ?? upstream.protocol
        upstream = {
          ...upstream,
          apiKey: credential.apiKey,
          apiKeys: undefined,
          rotationEnabled: false,
          subscriptionPool: undefined,
          selectedSubscriptionAccountId: accountId,
          rotationStrategy: undefined,
          baseUrl: credential.baseURL,
          protocol,
          apiFlavor: credential.apiFlavor ?? upstream.apiFlavor,
          enabled: true,
          transport: {
            ...upstream.transport,
            authScheme:
              protocol === "anthropic"
                ? "x-api-key"
                : protocol === "google" || protocol === "gemini"
                  ? "custom-header"
                  : "bearer",
            ...(protocol === "google" || protocol === "gemini"
              ? { authHeaderName: "x-goog-api-key" }
              : {}),
            staticHeaders: Object.entries(credential.headers ?? {}),
          },
        }
      }
      if (selected.providerId === "commandcode") {
        const protocol = resolveProviderProtocol(selected.providerId, selected.modelId) as
          "openai" | "anthropic"
        upstream = {
          ...upstream,
          protocol,
          transport: {
            ...upstream.transport,
            authScheme: protocol === "anthropic" ? "x-api-key" : "bearer",
          },
        }
      }
      if (
        !upstream.enabled ||
        !upstream.baseUrl ||
        (!upstream.apiKey && !upstream.apiKeys?.length && !allowsUnauthenticated)
      )
        throw new Error(`The selected Cognia model ${selector} has no usable gateway credential`)
      if (!["openai", "responses", "anthropic", "google", "gemini"].includes(upstream.protocol))
        throw new Error(
          "The selected provider protocol cannot serve this external agent through the gateway"
        )
      let modelAvailable = upstream.models.includes(selected.modelId)
      let metadataSettings = settings
      if (accountId) {
        metadataSettings = {
          ...settings,
          providerSettings: {
            ...settings.providerSettings,
            [selected.providerId]: {
              ...settings.providerSettings?.[selected.providerId],
              providerId: selected.providerId,
              defaultModel: selected.modelId,
              enabled: true,
              discoveredModels: [],
            },
          },
          customProviders: settings.customProviders?.map((entry) =>
            entry.id === selected.providerId ? { ...entry, discoveredModels: [] } : entry
          ),
        }
        if (definition?.modelApi?.list || definition?.modelApi?.retrieve) {
          const { getSubscriptionModel } = await import("@/lib/subscription/core/model-discovery")
          const detail = await getSubscriptionModel({
            definition,
            providerAccountId: accountId,
            model: selected.modelId,
            signal: input.signal,
          })
          assertCurrent()
          if (!detail.model)
            throw new Error("The selected subscription account does not provide this model")
          modelAvailable = true
          const discoveredModels = [detail.model]
          metadataSettings = {
            ...metadataSettings,
            providerSettings: {
              ...metadataSettings.providerSettings,
              [selected.providerId]: {
                ...metadataSettings.providerSettings?.[selected.providerId],
                providerId: selected.providerId,
                defaultModel: selected.modelId,
                enabled: true,
                discoveredModels,
              },
            },
            customProviders: metadataSettings.customProviders?.map((entry) =>
              entry.id === selected.providerId ? { ...entry, discoveredModels } : entry
            ),
          }
        }
      }
      if (!modelAvailable)
        throw new Error("The selected model is unavailable in the Cognia provider catalog")
      const metadata = publisher.gatewayModelMetadata(
        metadataSettings,
        selected.providerId,
        selected.modelId
      )
      if (metadata.supportsTools === false || metadata.supportsStreaming === false)
        throw new Error(
          `The selected model ${selected.modelId} does not support the tools and streaming this agent requires`
        )
      modelMetadataById[selector] = { ...metadata, id: selector }
      const deploymentId = `cognia-task-${encodeURIComponent(JSON.stringify([input.sessionId, selected.providerId, accountId ?? null, upstream.protocol]))}`
      selectorDeployments[selector] = deploymentId
      const existing = taskProviders.get(deploymentId)
      if (existing) {
        if (!existing.models.includes(selected.modelId)) existing.models.push(selected.modelId)
        if (!existing.modelMetadata?.some((item) => item.id === selected.modelId))
          existing.modelMetadata?.push(metadata)
      } else
        taskProviders.set(deploymentId, {
          ...upstream,
          sourceProviderId: upstream.sourceProviderId ?? upstream.id,
          id: deploymentId,
          deploymentId,
          models: [selected.modelId],
          modelMetadata: [metadata],
        })
    }
    for (const selector of Object.keys(effectivePlan?.bindings ?? {}))
      if (!requested.includes(selector))
        throw new Error("A task binding names a model outside the plan")
    const modelMetadata = modelMetadataById[input.modelId]
    const deploymentId = selectorDeployments[input.modelId]
    const taskProvider = taskProviders.get(deploymentId)!
    const concreteBindings = Object.fromEntries(
      requested.map((selector) => [
        selector,
        effectivePlan?.bindings?.[selector]?.modelId ??
          effectivePlan?.modelBindings[selector] ??
          selector,
      ])
    )
    const planDeployments = {
      ...Object.fromEntries(
        ["primary", "fast", "powerful", "sonnet", "haiku", "opus"].map((selector) => [
          selector,
          deploymentId,
        ])
      ),
      ...selectorDeployments,
    }
    const candidates = [...taskProviders.values()].map((provider) => ({
      deploymentId: provider.deploymentId!,
      modelId: provider.models[0],
    }))
    if (remoteScope) {
      const lease = await acquireRemoteTaskLease({
        scope: remoteScope,
        taskId: input.sessionId,
        provider: {
          ...taskProvider,
          apiKey: taskProvider.apiKey || taskProvider.apiKeys?.[0],
          apiKeys: [],
          rotationEnabled: false,
        },
        model: input.modelId,
        ...(effectivePlan
          ? { modelPlan: { ...effectivePlan, selectorDeployments: planDeployments } }
          : {}),
        providerOverrides: [...taskProviders.values()]
          .filter((provider) => provider.id !== taskProvider.id)
          .map((provider) => ({
            ...provider,
            apiKey: provider.apiKey || provider.apiKeys?.[0],
            apiKeys: [],
            rotationEnabled: false,
          })),
        ingressProtocol: input.ingressProtocol ?? "openai-chat",
        ...(input.budget ? { budget: input.budget } : {}),
        assertCurrent,
        signal: input.signal,
        onDisposed: releaseAuthority,
        subscribeAuthority: (listener) => {
          authorityListeners.add(listener)
          return () => {
            authorityListeners.delete(listener)
          }
        },
      })
      transferredAuthority = true
      return {
        ...lease,
        ownerAccountId: ownerAccountId ?? null,
        revoke: async () => {
          try {
            await lease.revoke()
          } finally {
            releaseAuthority()
          }
        },
        model: input.modelId,
        modelMetadata,
        modelMetadataById,
        binding: {
          providerId: input.providerId,
          modelId: input.modelId,
          accountId: providerAccountId ?? null,
        },
      }
    }
    const pushed = await gatewayPushSnapshot(
      snapshot,
      ownerAccountId ? { ownerAccountId, accountGeneration } : undefined
    )
    assertCurrent()
    if (!pushed?.accepted)
      throw new Error("The Cognia gateway rejected the current provider snapshot")
    const minted = await gatewayMintRouteTicket(
      {
        sessionId: input.sessionId,
        executionFingerprint: contentDigest({
          executionFingerprint: input.executionFingerprint,
          sessionId: input.sessionId,
          modelBindings: concreteBindings,
          selectorDeployments: planDeployments,
          bridgeModels: gatewayConfig.bridgeModels,
        }),
        candidates,
        providerOverrides: [...taskProviders.values()],
        selectorDeployments: planDeployments,
        model: input.modelId,
        modelBindings: {
          ...Object.fromEntries(
            [input.modelId, "primary", "fast", "powerful", "sonnet", "haiku", "opus"].map(
              (selector) => [selector, input.modelId]
            )
          ),
          ...(effectivePlan?.modelBindings ?? {}),
          ...concreteBindings,
        },
        ...(effectivePlan ? { strictSelectors: true } : {}),
        credentialAffinity: "session-sticky",
        allowAuthFailover: false,
        routePolicy: "gateway-required",
        operations: [
          input.ingressProtocol === "openai-responses" ? "responses" : "chat",
          "models",
          "count-tokens",
        ],
        ...(input.budget ? { budget: input.budget } : {}),
      },
      { required: true }
    )
    try {
      assertCurrent()
      const after = await gatewayGetStatus()
      if (
        after.accountGeneration !== accountGeneration ||
        !after.running ||
        after.boundPort !== status!.boundPort
      )
        throw new Error("Cognia gateway ownership changed while preparing the task")
      assertCurrent()
      return {
        endpoint: endpointFor(status!.boundPort!),
        ticketId: minted.ticket.ticketId,
        secret: minted.secret,
        model: input.modelId,
        modelMetadata,
        modelMetadataById,
        ownerAccountId: ownerAccountId ?? null,
        binding: {
          providerId: input.providerId,
          modelId: input.modelId,
          accountId: providerAccountId ?? null,
        },
      }
    } catch (error) {
      await gatewayRevokeRouteTicket(minted.ticket.ticketId)
      throw error
    }
  } finally {
    if (!transferredAuthority) releaseAuthority()
  }
}
