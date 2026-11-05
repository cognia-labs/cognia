import { act, render } from "@testing-library/react"

import type { RendererRuntimeEntry } from "@/lib/modules/manifest-types"

const mockStop = jest.fn<Promise<void>, []>()
const mockStart = jest.fn((..._args: unknown[]) => ({
  started: Promise.resolve({ started: [], failed: [], skipped: [] }),
  stop: mockStop,
}))
jest.mock("@/lib/modules/runtime-runner", () => ({
  startModuleRuntimes: (...args: unknown[]) => mockStart(...args),
}))

const mockEntries = new Map<string | undefined, RendererRuntimeEntry[]>()
jest.mock("@/lib/modules/runtimes", () => ({
  RENDERER_HOST: "desktop",
  rendererRuntimes: (boot?: string) => mockEntries.get(boot) ?? [],
}))

let mockRole = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockRole,
  isSecondaryOverlayRole: (role: string) => role !== "main" && role !== "web",
}))

import { useAccountStore } from "@/stores/account/account-store"

import { __resetModuleRuntimeHostForTests, ModuleRuntimeHost } from "./module-runtime-host"

const runtime = (name: string): RendererRuntimeEntry => ({
  module: "demo",
  stage: "stable",
  name,
  criticality: "optional",
  load: async () => ({ start: () => undefined }),
})

function unlock(accountId: string | null, revision = 1) {
  act(() => {
    useAccountStore.setState({ unlockedAccountId: accountId, accountRevision: revision })
  })
}

beforeEach(() => {
  mockStart.mockClear()
  mockStop.mockReset().mockResolvedValue(undefined)
  mockEntries.clear()
  mockRole = "main"
  __resetModuleRuntimeHostForTests()
  unlock(null, 0)
})

describe("ModuleRuntimeHost", () => {
  it("starts its group's runtimes for the unlocked account and stops them on unmount", () => {
    const squad = runtime("squad")
    mockEntries.set("knowledge-agents", [squad])
    unlock("acct_a")
    const { unmount, container } = render(<ModuleRuntimeHost boot="knowledge-agents" />)
    expect(container.innerHTML).toBe("")
    expect(mockStart).toHaveBeenCalledTimes(1)
    const [entries, ctx, options] = mockStart.mock.calls[0]!
    expect(entries).toEqual([squad])
    expect(ctx).toMatchObject({ host: "desktop", accountId: "acct_a" })
    expect(options).toEqual({ after: undefined })
    unmount()
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it("starts nothing while the account is locked", () => {
    mockEntries.set(undefined, [runtime("drain")])
    render(<ModuleRuntimeHost />)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("starts nothing for a group no runtime waits for", () => {
    unlock("acct_a")
    render(<ModuleRuntimeHost boot="integrations" />)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("starts nothing in the pet's overlay windows", () => {
    mockEntries.set(undefined, [runtime("drain")])
    mockRole = "overlay"
    unlock("acct_a")
    render(<ModuleRuntimeHost />)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("restarts against the newly selected account once the old run has stopped", () => {
    mockEntries.set(undefined, [runtime("drain")])
    const firstStop = Promise.resolve()
    mockStop.mockReturnValueOnce(firstStop)
    unlock("acct_a", 1)
    render(<ModuleRuntimeHost />)
    unlock("acct_b", 2)
    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(mockStart).toHaveBeenCalledTimes(2)
    const [, ctx, options] = mockStart.mock.calls[1]!
    expect(ctx).toMatchObject({ accountId: "acct_b" })
    expect(options).toEqual({ after: firstStop })
  })
})
