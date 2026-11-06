import {
  __clearDocsProvidersForTests,
  __resetDocsProvidersForTests,
  docsProviderPrefixes,
  getDocsProvider,
  getDocsProviderByPrefix,
  listDocsProviders,
  registerDocsProvider,
  resolveDocsProvider,
  whenDocsProvidersReady,
  type DocsProvider,
} from "./index"
import * as registry from "./registry"
import { __resetPortsForTesting, __setPortModulesForTesting } from "@/lib/modules/ports"
import type { HostModuleManifest } from "@/lib/modules/manifest-types"

beforeEach(() => __resetDocsProvidersForTests())
// A test that swaps the port's providers also forgets the members it loaded.
afterEach(() => __resetPortsForTesting())

function stubProvider(id: string, prefix: string): DocsProvider {
  return {
    id,
    mentionPrefix: prefix,
    kinds: ["doc"],
    hosts: ["tauri"],
    listAccounts: async () => [],
    matchRef: () => null,
    fetch: async () => {
      throw new Error("unused")
    },
  } as unknown as DocsProvider
}

function moduleProviding(id: string, load: () => Promise<unknown>): HostModuleManifest {
  return {
    id,
    kind: "module",
    stage: "stable",
    provides: [{ port: "docs-provider", load }],
  } as unknown as HostModuleManifest
}

describe("built-in docs providers", () => {
  it("registers Lark and Google from the docs-provider port, in the URL catalog's order", () => {
    expect(listDocsProviders().map((provider) => provider.id)).toEqual(["lark", "google"])
    expect(getDocsProvider("lark")).toMatchObject({ id: "lark", mentionPrefix: "lark:" })
    expect(getDocsProvider("google")).toMatchObject({ id: "google", mentionPrefix: "gdoc:" })
  })

  it("claims distinct, colon-terminated mention prefixes", () => {
    expect(docsProviderPrefixes()).toEqual([
      { prefix: "lark:", providerId: "lark" },
      { prefix: "gdoc:", providerId: "google" },
    ])
    expect(getDocsProviderByPrefix("lark:")).toBe(getDocsProvider("lark"))
    expect(getDocsProviderByPrefix("gdoc:")).toBe(getDocsProvider("google"))
  })

  it("keeps every provider id a valid Rust callback slug", () => {
    // `is_docs_provider_slug` in crates/cognia-connectors/src/axum_app.rs.
    for (const provider of listDocsProviders()) {
      expect(provider.id).toMatch(/^[a-z0-9-]{1,32}$/)
    }
  })

  it("declares at least one readable kind per provider", () => {
    for (const provider of listDocsProviders()) {
      expect(provider.kinds.length).toBeGreaterThan(0)
    }
  })

  it("re-evaluates the barrel without replacing existing providers", async () => {
    const before = listDocsProviders()
    const revision = registry.getDocsProvidersRevision()
    try {
      jest.doMock("./registry", () => registry)
      jest.isolateModules(() => jest.requireActual("./index"))
      await whenDocsProvidersReady()
      expect(listDocsProviders()).toHaveLength(before.length)
      for (const provider of before) expect(getDocsProvider(provider.id)).toBe(provider)
      expect(registry.getDocsProvidersRevision()).toBe(revision)
    } finally {
      jest.dontMock("./registry")
    }
  })

  it("restores exactly the built-in set after a reset", async () => {
    registerDocsProvider(stubProvider("plugin:x", "x:"))
    await __resetDocsProvidersForTests()
    expect(listDocsProviders().map((provider) => provider.id)).toEqual(["lark", "google"])
  })
})

describe("loading the built-ins", () => {
  it("starts on the first read and registers each member as it arrives", async () => {
    let isolated!: typeof import("./registry")
    jest.isolateModules(() => {
      isolated = jest.requireActual("./registry")
    })
    const heard = jest.fn()
    isolated.subscribeDocsProviders(heard)
    expect(isolated.listDocsProviders()).toEqual([])
    await isolated.whenDocsProvidersReady()
    expect(isolated.listDocsProviders().map((provider) => provider.id)).toEqual(["lark", "google"])
    expect(heard).toHaveBeenCalled()
  })

  it("lets a waiting caller resolve a built-in", async () => {
    await expect(resolveDocsProvider("google")).resolves.toBe(getDocsProvider("google"))
    await expect(resolveDocsProvider("missing")).resolves.toBeUndefined()
  })

  it("keeps the built-ins out after a clear, including a load already in flight", async () => {
    let release!: () => void
    __resetPortsForTesting()
    __setPortModulesForTesting([
      moduleProviding(
        "slow-docs",
        () =>
          new Promise((resolve) => {
            release = () => resolve({ port: stubProvider("slow", "slow:") })
          })
      ),
    ])
    const reset = __resetDocsProvidersForTests()
    __clearDocsProvidersForTests()
    release()
    await reset
    await whenDocsProvidersReady()
    expect(listDocsProviders()).toEqual([])
    expect(getDocsProvider("slow")).toBeUndefined()
  })

  it("registers the members that load and retries the one that failed", async () => {
    __resetPortsForTesting()
    const failing = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValue({ port: stubProvider("flaky", "flaky:") })
    __setPortModulesForTesting([
      moduleProviding("steady-docs", async () => ({ port: stubProvider("steady", "steady:") })),
      moduleProviding("flaky-docs", failing),
    ])
    await __resetDocsProvidersForTests()
    expect(listDocsProviders().map((provider) => provider.id)).toEqual(["steady"])
    await whenDocsProvidersReady()
    expect(listDocsProviders().map((provider) => provider.id)).toEqual(["steady", "flaky"])
    expect(failing).toHaveBeenCalledTimes(2)
  })
})
