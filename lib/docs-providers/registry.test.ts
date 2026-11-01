jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: jest.fn(() => "tauri"),
}))

import { detectPlatform, type Platform } from "@/lib/platform/detect"
import {
  __clearDocsProvidersForTests,
  docsProviderPrefixes,
  getDocsProvider,
  getDocsProviderByPrefix,
  isDocsProviderHostSupported,
  listAvailableDocsProviders,
  listDocsProviders,
  registerDocsProvider,
  getDocsProvidersRevision,
  subscribeDocsProviders,
  trackDocsProviderRequest,
  unregisterDocsProvider,
} from "./registry"
import type { DocsProvider } from "./types"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

const mockDetectPlatform = detectPlatform as jest.MockedFunction<typeof detectPlatform>

function stubProvider(overrides: Partial<DocsProvider> = {}): DocsProvider {
  return {
    id: "stub",
    mentionPrefix: "stub:",
    kinds: ["doc"],
    hosts: ["tauri"],
    listAccounts: async () => [],
    matchRef: () => null,
    fetch: async () => {
      throw new Error("not implemented")
    },
    ...overrides,
  }
}

function setPlatform(platform: Platform): void {
  mockDetectPlatform.mockReturnValue(platform)
}

describe("docs provider registry", () => {
  beforeEach(() => {
    __clearDocsProvidersForTests()
    setPlatform("tauri")
  })

  it("registers and resolves by id", () => {
    const provider = stubProvider()
    registerDocsProvider(provider)
    expect(getDocsProvider("stub")).toMatchObject({
      id: provider.id,
      mentionPrefix: provider.mentionPrefix,
    })
    expect(listDocsProviders()).toEqual([getDocsProvider(provider.id)])
  })

  it("preserves Host invocation admission through the managed account-list wrapper", async () => {
    const listAccounts = jest.fn(async (_options?: unknown) => [])
    registerDocsProvider(stubProvider({ listAccounts }))
    const options = { credentialContext: { localAuthorization: LOCAL_PERSON_RUN } } as const
    await getDocsProvider("stub")!.listAccounts(options)
    expect(listAccounts).toHaveBeenCalledWith(options)
    await getDocsProvider("stub")!.listAccounts()
    expect(listAccounts).toHaveBeenLastCalledWith(undefined)
  })

  it("returns undefined for an unknown id", () => {
    expect(getDocsProvider("nope")).toBeUndefined()
  })

  it("publishes registration and disposal revisions, with an idempotent disposer", () => {
    const before = getDocsProvidersRevision()
    const changed = jest.fn()
    const stop = subscribeDocsProviders(changed)
    const dispose = registerDocsProvider(stubProvider())
    expect(getDocsProvidersRevision()).toBe(before + 1)
    expect(changed).toHaveBeenCalledTimes(1)
    dispose()
    expect(getDocsProvidersRevision()).toBe(before + 2)
    expect(changed).toHaveBeenCalledTimes(2)
    dispose()
    expect(changed).toHaveBeenCalledTimes(2)
    stop()
  })

  it("aborts reads synchronously on removal, and an old disposer cannot remove a replacement", () => {
    const original = stubProvider()
    const dispose = registerDocsProvider(original)
    const controller = new AbortController()
    const published = getDocsProvider(original.id)!
    const untrack = trackDocsProviderRequest(published, controller)
    unregisterDocsProvider(original.id)
    expect(controller.signal.aborted).toBe(true)
    const replacement = stubProvider()
    registerDocsProvider(replacement)
    const current = getDocsProvider(original.id)
    dispose()
    expect(getDocsProvider(original.id)).toBe(current)
    expect(current).not.toBe(published)
    const stale = new AbortController()
    trackDocsProviderRequest(published, stale)
    expect(stale.signal.aborted).toBe(true)
    untrack()
  })

  it("unregisters a dynamically contributed provider", () => {
    registerDocsProvider(stubProvider())
    expect(unregisterDocsProvider("stub")).toBe(true)
    expect(unregisterDocsProvider("stub")).toBe(false)
    expect(listDocsProviders()).toEqual([])
  })

  it("throws on a duplicate id", () => {
    registerDocsProvider(stubProvider())
    expect(() => registerDocsProvider(stubProvider())).toThrow(/already registered/)
  })

  it("throws when two providers claim the same mention prefix", () => {
    registerDocsProvider(stubProvider())
    expect(() => registerDocsProvider(stubProvider({ id: "other" }))).toThrow(
      /already used by "stub"/
    )
  })

  it("rejects a mention prefix that is not colon-terminated", () => {
    expect(() => registerDocsProvider(stubProvider({ mentionPrefix: "stub" }))).toThrow(
      /must end with ":"/
    )
  })

  it("maps prefixes back to provider ids", () => {
    const provider = stubProvider()
    registerDocsProvider(provider)
    expect(docsProviderPrefixes()).toEqual([{ prefix: "stub:", providerId: "stub" }])
    expect(getDocsProviderByPrefix("stub:")).toBe(getDocsProvider(provider.id))
    expect(getDocsProviderByPrefix("missing:")).toBeUndefined()
  })

  describe("host gating (intentional dormancy — project rule 7, test axis)", () => {
    it("exposes a tauri-only provider on the desktop", () => {
      const provider = stubProvider()
      registerDocsProvider(provider)
      expect(listAvailableDocsProviders()).toEqual([getDocsProvider(provider.id)])
      expect(isDocsProviderHostSupported(provider)).toBe(true)
    })

    it.each<Platform>(["web", "mobile", "headless"])(
      "hides a tauri-only provider on %s",
      (platform) => {
        const provider = stubProvider()
        registerDocsProvider(provider)
        setPlatform(platform)
        expect(listAvailableDocsProviders()).toEqual([])
        expect(isDocsProviderHostSupported(provider)).toBe(false)
      }
    )

    it("still reports the prefix on an unsupported host so the panel can explain itself", () => {
      registerDocsProvider(stubProvider())
      setPlatform("web")
      expect(docsProviderPrefixes()).toEqual([{ prefix: "stub:", providerId: "stub" }])
    })
  })
})
