jest.mock("@/lib/execution/personal-sink", () => ({
  ...jest.requireActual("@/lib/execution/personal-sink"),
  assertPersonalSink: jest.fn(async () => {}),
  readRunPersonalTaint: jest.fn(async () => ({ verified: true, marks: [] })),
}))
jest.mock("@/lib/browser/agent-engine", () => ({
  routeEngine: jest.fn(() => ({ engine: {} })),
  primeLocalBrowserRouting: jest.fn(async () => undefined),
  ensureAgentLocalEngine: jest.fn(async () => ({ backend: "local-chromium" })),
}))
jest.mock("@/lib/browser/domain-authorization", () => ({
  isBrowserDomainAuthorized: jest.fn(() => true),
  primeBrowserDomainGrants: jest.fn(async () => ["example.com"]),
}))
jest.mock("@/lib/db/browser-annotations", () => ({
  saveBrowserAnnotation: jest.fn(async () => undefined),
}))
jest.mock("@/lib/browser/downloads-client", () => ({
  requestBrowserDownloadAttach: jest.fn(() => true),
}))
jest.mock("@/lib/browser/open-url-request", () => ({
  requestBrowserUrl: jest.fn(() => true),
  isBrowserSurfaceVisible: jest.fn(() => false),
}))

import {
  ensureAgentLocalEngine,
  primeLocalBrowserRouting,
  routeEngine,
} from "@/lib/browser/agent-engine"
import {
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
} from "@/lib/browser/domain-authorization"
import { requestBrowserDownloadAttach } from "@/lib/browser/downloads-client"
import { isBrowserSurfaceVisible, requestBrowserUrl } from "@/lib/browser/open-url-request"
import { saveBrowserAnnotation } from "@/lib/db/browser-annotations"
import { SUBMISSION_GUARD_METHODS, gateBrowserEngine } from "@/lib/browser/submission-gate"
import {
  createBrowserAPI,
  createPluginBrowserEngineFacade,
  FIRST_PARTY_BROWSER_PLUGIN_ID,
  isFirstPartyBrowserPlugin,
  PRIVILEGED_BROWSER_ENGINE_METHODS,
} from "./browser-api"
import type { BrowserEngine } from "@/lib/browser/agent-engine"
import { withPluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import { assertPersonalSink } from "@/lib/execution/personal-sink"

/** A fake engine: every member is a jest.fn except the data properties. */
function fakeEngine(): BrowserEngine & Record<string, jest.Mock> {
  const methods = [
    "navigate",
    "snapshot",
    "act",
    "evaluate",
    "getPage",
    "setStorage",
    ...PRIVILEGED_BROWSER_ENGINE_METHODS,
  ]
  const engine: Record<string, unknown> = { backend: "local-chromium", credentialFilled: true }
  for (const method of methods) engine[method] = jest.fn(async () => ({ ok: true }))
  return engine as unknown as BrowserEngine & Record<string, jest.Mock>
}

describe("createBrowserAPI", () => {
  it("captures the Host invocation's execution instead of plugin routing claims", async () => {
    const engine = fakeEngine()
    jest.mocked(routeEngine).mockReturnValueOnce({ engine } as never)
    const api = createBrowserAPI({ pluginId: "provenance-plugin" })
    const routed = withPluginExecutionContext(
      "provenance-plugin",
      { executionRunId: "host-execution" },
      () => api.routeEngine("https://example.com", { botRunId: "plugin-claim" }).engine
    )
    await withPluginExecutionContext(
      "provenance-plugin",
      { executionRunId: "host-execution" },
      () => routed.navigate("https://example.com")
    )
    expect(assertPersonalSink).toHaveBeenCalledWith(
      { sessionId: undefined, executionRunId: "host-execution" },
      { kind: "unknown", label: "opaque browser action" },
      undefined,
      "https://example.com"
    )
  })
  it("delegates routing and domain consent to the host", async () => {
    const api = createBrowserAPI({ firstParty: true })

    api.routeEngine("https://example.com", { domainAuthorized: true })
    expect(routeEngine).toHaveBeenCalledWith("https://example.com", { domainAuthorized: true })
    expect(api.isDomainAuthorized("https://example.com")).toBe(true)
    expect(isBrowserDomainAuthorized).toHaveBeenCalledWith("https://example.com")
    await expect(api.primeDomainGrants()).resolves.toEqual(["example.com"])
    expect(primeBrowserDomainGrants).toHaveBeenCalledTimes(1)
  })

  it("persists annotations through the host database seam", async () => {
    const annotation = { id: "annotation-1" } as Parameters<
      ReturnType<typeof createBrowserAPI>["saveAnnotation"]
    >[0]

    await createBrowserAPI().saveAnnotation(annotation)

    expect(saveBrowserAnnotation).toHaveBeenCalledWith(annotation)
  })

  it("exposes the ADR-0201 local runtime, pane and attach seams", async () => {
    const api = createBrowserAPI()
    await api.primeLocalRouting()
    expect(primeLocalBrowserRouting).toHaveBeenCalled()
    await api.ensureLocalEngine("user-chrome", { browser: "edge" })
    expect(ensureAgentLocalEngine).toHaveBeenCalledWith("user-chrome", { browser: "edge" })
    expect(api.openPane("https://a.test", { backend: "local-chromium" })).toBe(true)
    expect(requestBrowserUrl).toHaveBeenCalledWith("https://a.test", {
      backend: "local-chromium",
      source: "agent",
    })
    api.openPane("")
    expect(requestBrowserUrl).toHaveBeenLastCalledWith("", { source: "agent" })
    api.openPane("https://b.test", { chatSessionId: "chat-2" })
    expect(requestBrowserUrl).toHaveBeenLastCalledWith("https://b.test", {
      chatSessionId: "chat-2",
      source: "agent",
    })
    await api.ensureLocalEngine("local-chromium", { chatSessionId: "chat-2" })
    expect(ensureAgentLocalEngine).toHaveBeenLastCalledWith("local-chromium", {
      chatSessionId: "chat-2",
    })
    const download = {
      id: "d",
      sessionId: "s",
      filename: "f",
      size: 1,
      state: "completed" as const,
    }
    expect(api.attachDownload(download, "chat-1")).toBe(true)
    expect(requestBrowserDownloadAttach).toHaveBeenCalledWith(download, "chat-1")
    expect(api.isSurfaceVisible()).toBe(false)
    expect(isBrowserSurfaceVisible).toHaveBeenCalled()
  })
})

describe("plugin engine facade (ADR-0201)", () => {
  it("recognises only the bundled Browser Tools plugin as first-party", () => {
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", "builtin")).toBe(true)
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", "local")).toBe(false)
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", "marketplace")).toBe(false)
    expect(isFirstPartyBrowserPlugin("other", "builtin")).toBe(false)
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", undefined)).toBe(false)
  })

  it("omits the privileged methods and forwards the rest", async () => {
    const engine = fakeEngine()
    const facade = createPluginBrowserEngineFacade(engine) as unknown as Record<string, unknown>
    for (const method of PRIVILEGED_BROWSER_ENGINE_METHODS) {
      expect(facade[method]).toBeUndefined()
      expect(method in facade).toBe(false)
    }
    await (facade.navigate as (url: string) => Promise<unknown>)("https://a.test")
    expect(engine.navigate).toHaveBeenCalledWith("https://a.test")
    await (facade.setStorage as (...a: string[]) => Promise<unknown>)("local", "k", "v")
    expect(engine.setStorage).toHaveBeenCalledWith("local", "k", "v")
    expect(facade.backend).toBe("local-chromium")
    expect(facade.credentialFilled).toBe(true)
    expect(Object.isFrozen(facade)).toBe(true)
    expect(Object.getPrototypeOf(facade)).toBeNull()
    // Stable identity per engine.
    expect(createPluginBrowserEngineFacade(engine)).toBe(facade)
  })

  it("never forwards the post-fill approval flag through evaluate", async () => {
    const engine = fakeEngine()
    const facade = createPluginBrowserEngineFacade(engine)
    await facade.evaluate("document.title", { credentialFillApproved: true })
    expect(engine.evaluate).toHaveBeenCalledWith("document.title")
    expect((engine.evaluate as unknown as jest.Mock).mock.calls[0]).toHaveLength(1)
  })

  it("routes and ensures through the facade unless the caller is first-party", async () => {
    const engine = fakeEngine()
    ;(routeEngine as jest.Mock).mockReturnValue({ engine, backend: "local-chromium" })
    ;(ensureAgentLocalEngine as jest.Mock).mockResolvedValue(engine)

    const thirdParty = createBrowserAPI()
    const routed = thirdParty.routeEngine("https://a.test")
    expect(routed.backend).toBe("local-chromium")
    expect(routed.engine.fillCredential).toBeUndefined()
    expect((await thirdParty.ensureLocalEngine("local-chromium")).getStorage).toBeUndefined()

    // The first-party plugin keeps the full engine, behind the submission gate.
    const firstParty = createBrowserAPI({ firstParty: true })
    const full = firstParty.routeEngine("https://a.test").engine
    expect(full).toBe(
      gateBrowserEngine(engine, { kind: "plugin", pluginId: FIRST_PARTY_BROWSER_PLUGIN_ID })
    )
    expect(typeof full.fillCredential).toBe("function")
    await expect(firstParty.ensureLocalEngine("local-chromium")).resolves.toBe(full)
  })

  it("gates every engine for the asker the outbound policy names (ADR-0239 phase 2b)", async () => {
    const engine = fakeEngine()
    ;(routeEngine as jest.Mock).mockReturnValue({ engine, backend: "local-chromium" })
    ;(ensureAgentLocalEngine as jest.Mock).mockResolvedValue(engine)

    // The built-in tools act for the chat, or the bridge client, that called them.
    const firstParty = createBrowserAPI({
      firstParty: true,
      pluginId: FIRST_PARTY_BROWSER_PLUGIN_ID,
    })
    expect(firstParty.routeEngine("https://a.test", { chatSessionId: "chat-1" }).engine).toBe(
      gateBrowserEngine(engine, { kind: "chat", sessionId: "chat-1" })
    )
    await expect(
      firstParty.ensureLocalEngine("local-chromium", {
        chatSessionId: "external-bridge:browser:claude",
      })
    ).resolves.toBe(gateBrowserEngine(engine, { kind: "external-bridge", clientId: "claude" }))

    // Any other plugin acts for itself, whatever session it names.
    const thirdParty = createBrowserAPI({ pluginId: "acme" })
    const routed = thirdParty.routeEngine("https://a.test", { chatSessionId: "chat-1" }).engine
    expect(routed).toBe(
      createPluginBrowserEngineFacade(
        gateBrowserEngine(engine, { kind: "plugin", pluginId: "acme" })
      )
    )
    for (const method of SUBMISSION_GUARD_METHODS) {
      expect((routed as unknown as Record<string, unknown>)[method]).toBeUndefined()
    }

    // A handler Bot's engine names its run, each run its own gate.
    const forRun = thirdParty.routeEngine("https://a.test", { botRunId: "run-1" }).engine
    expect(forRun).toBe(
      createPluginBrowserEngineFacade(
        gateBrowserEngine(engine, { kind: "plugin", pluginId: "acme", botRunId: "run-1" })
      )
    )
    expect(forRun).not.toBe(routed)
    await expect(
      thirdParty.ensureLocalEngine("local-chromium", { botRunId: "run-2" })
    ).resolves.toBe(
      createPluginBrowserEngineFacade(
        gateBrowserEngine(engine, { kind: "plugin", pluginId: "acme", botRunId: "run-2" })
      )
    )
    expect(
      gateBrowserEngine(engine, { kind: "plugin", pluginId: "acme", botRunId: "run-2" })
    ).not.toBe(gateBrowserEngine(engine, { kind: "plugin", pluginId: "acme", botRunId: "run-1" }))
  })
})

it("H4: a primed run opens its pane synchronously with no hot-path read", async () => {
  const { personalEgressFenced } = await import("@/lib/execution/personal-egress")
  const host = await import("@/lib/execution/personal-sink")
  await personalEgressFenced({ executionRunId: "clear-pane" })
  jest.mocked(host.readRunPersonalTaint).mockClear()
  const value = withPluginExecutionContext("pane-plugin", { executionRunId: "clear-pane" }, () =>
    createBrowserAPI({ pluginId: "pane-plugin" }).openPane("https://example.com/private")
  )
  expect(value).toBe(true)
  expect(host.readRunPersonalTaint).not.toHaveBeenCalled()
})

it("H4: marked and cache-missing run pane egress fails synchronously", async () => {
  const { personalEgressFenced } = await import("@/lib/execution/personal-egress")
  const host = await import("@/lib/execution/personal-sink")
  jest
    .mocked(host.readRunPersonalTaint)
    .mockImplementation(
      async (context) =>
        ({ verified: true, marks: context.executionRunId === "marked-pane" ? [{}] : [] }) as never
    )
  await personalEgressFenced({ executionRunId: "marked-pane" })
  const before = jest.mocked(requestBrowserUrl).mock.calls.length
  for (const executionRunId of ["marked-pane"]) {
    expect(
      withPluginExecutionContext("pane-plugin", { executionRunId }, () =>
        createBrowserAPI({ pluginId: "pane-plugin" }).openPane("https://example.com/private")
      )
    ).toBe(false)
  }
  expect(jest.mocked(requestBrowserUrl).mock.calls.length).toBe(before)
})

it("R7: an untainted cache miss opens after one read and primes subsequent synchronous calls", async () => {
  const host = await import("@/lib/execution/personal-sink")
  jest.mocked(host.readRunPersonalTaint).mockClear()
  const open = () =>
    withPluginExecutionContext("reload-pane", { executionRunId: "reload-run" }, () =>
      createBrowserAPI({ pluginId: "reload-pane" }).openPane("https://example.com")
    )
  const accepted: boolean = open()
  expect(accepted).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.readRunPersonalTaint).toHaveBeenCalledTimes(1)
  expect(open()).toBe(true)
  expect(host.readRunPersonalTaint).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  "F8 openPane stays boolean and defers navigation behind a real taint read (marked=%s)",
  async (marked) => {
    const fixture = (await import("@/lib/db/test-fixture")).createDbTestFixture({ seeded: false })
    await fixture.initialize()
    const sink = await import("@/lib/execution/personal-sink")
    const actual = jest.requireActual<typeof import("@/lib/execution/personal-sink")>(
      "@/lib/execution/personal-sink"
    )
    jest.mocked(sink.readRunPersonalTaint).mockImplementation(actual.readRunPersonalTaint)
    const { startToolExecutionRun, LOCAL_PERSON_RUN } =
      await import("@/lib/execution/acting-authority")
    const { invalidatePersonalEgressCache } = await import("@/lib/execution/personal-egress")
    const { getDb } = await import("@/lib/db/schema")
    try {
      const run = await startToolExecutionRun("f8-pane", {
        localAuthorization:
          LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
      })
      if (marked)
        await getDb().executionRuns.update(run.id, {
          personalMarks: [{ person: { kind: "local-person" }, source: "F8", markedAt: 1 }],
        })
      invalidatePersonalEgressCache(run.id)
      jest.mocked(sink.readRunPersonalTaint).mockClear()
      jest.mocked(requestBrowserUrl).mockClear()
      const accepted: boolean = withPluginExecutionContext(
        "f8-" + run.id,
        { executionRunId: run.id },
        () => createBrowserAPI({ pluginId: "f8-" + run.id }).openPane("https://example.com")
      )
      expect(accepted).toBe(true)
      expect(requestBrowserUrl).toHaveBeenCalledTimes(1)
      expect(requestBrowserUrl).toHaveBeenLastCalledWith(
        "https://example.com",
        expect.objectContaining({ probe: true })
      )
      for (let n = 0; n < 30; n++) await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        jest.mocked(requestBrowserUrl).mock.calls.filter(([, options]) => !options?.probe)
      ).toHaveLength(marked ? 0 : 1)
      expect(sink.readRunPersonalTaint).toHaveBeenCalledTimes(1)
    } finally {
      jest
        .mocked(sink.readRunPersonalTaint)
        .mockImplementation(async () => ({ verified: true, marks: [] }))
      await fixture.dispose()
    }
  }
)
