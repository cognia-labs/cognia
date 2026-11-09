/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

// Back the un-injected (production) path: real fs adapter + Tauri home resolver.
jest.mock("@/lib/file/file-operations", () => ({
  exists: jest.fn(async () => true),
  readDir: jest.fn(async () => []),
  statFile: jest.fn(async () => ({ size: 5, isFile: true })),
}))
jest.mock("@tauri-apps/api/path", () => ({ homeDir: jest.fn(async () => "/Users/x/") }))

import { useExternalMemory } from "./use-external-memory"
import { useProjectStore } from "@/stores/project/project-store"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"

const file = (over: Partial<ExternalMemoryFile> = {}): ExternalMemoryFile => ({
  id: "id1",
  agent: "claude-code",
  scope: "user",
  absPath: "/Users/x/.claude/CLAUDE.md",
  label: "~/.claude/CLAUDE.md",
  editable: true,
  exists: true,
  ...over,
})

function setActiveProjectWithRoot(path: string) {
  act(() => {
    useProjectStore.setState({
      loaded: true,
      activeProjectId: "p1",
      projects: [
        {
          id: "p1",
          name: "P",
          roots: [{ id: "r1", path, isPrimary: true }],
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: new Date(),
        } as never,
      ],
    })
  })
}

afterEach(() => {
  act(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })
})

describe("useExternalMemory", () => {
  it("reports unsupported off-desktop and discovers nothing", () => {
    const discover = jest.fn()
    const { result } = renderHook(() =>
      useExternalMemory({ isDesktop: false, discover, resolveHomeFn: async () => "/Users/x" })
    )
    expect(result.current.unsupported).toBe(true)
    expect(result.current.files).toEqual([])
    expect(discover).not.toHaveBeenCalled()
  })

  it("discovers files and confines writes to the agent dirs + workspace roots", async () => {
    setActiveProjectWithRoot("/proj")
    const discover = jest.fn().mockResolvedValue([file()])
    const { result } = renderHook(() =>
      useExternalMemory({
        isDesktop: true,
        platform: "macos",
        fs: {} as never,
        discover,
        resolveHomeFn: async () => "/Users/x",
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.files).toHaveLength(1)
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ home: "/Users/x", roots: ["/proj"], cwd: "/proj" })
    )
    expect(result.current.allowedRoots).toEqual(
      expect.arrayContaining(["/proj", "/Users/x/.claude", "/Users/x/.codex"])
    )
  })

  it("lets the editor save every global file discovery marks editable", async () => {
    setActiveProjectWithRoot("/proj")
    const discover = jest.fn().mockResolvedValue([])
    const { result } = renderHook(() =>
      useExternalMemory({
        isDesktop: true,
        platform: "macos",
        fs: {} as never,
        discover,
        resolveHomeFn: async () => "/Users/x",
        resolveVendorRootsFn: async () => {
          throw new Error("no ipc")
        },
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.allowedRoots).toEqual([
      "/proj",
      "/Users/x/.claude",
      "/Users/x/.codex",
      "/Users/x/.config/opencode",
      "/Users/x/.pi/agent",
    ])
    const { isWithinAllowedRoots } = await import("@/lib/memory/external/edit")
    for (const path of [
      "/Users/x/.config/opencode/AGENTS.md",
      "/Users/x/.pi/agent/SYSTEM.md",
      "/Users/x/.pi/agent/APPEND_SYSTEM.md",
    ]) {
      expect(isWithinAllowedRoots(path, result.current.allowedRoots)).toBe(true)
    }
    expect(isWithinAllowedRoots("/Users/x/.ssh/config", result.current.allowedRoots)).toBe(false)
  })

  it("passes relocated vendor roots to discovery and to the save allowlist", async () => {
    setActiveProjectWithRoot("/proj")
    const discover = jest.fn().mockResolvedValue([])
    const vendorRoots = {
      claudeConfigDir: "/cfg/claude",
      codexHome: "/cfg/codex",
      opencodeConfigDir: "/xdg/opencode",
      opencodeDataDir: "",
      piAgentDir: "/cfg/pi",
      piSessionDir: "",
      geminiDir: "",
      continueDir: "",
      cursorDir: "",
    }
    const { result } = renderHook(() =>
      useExternalMemory({
        isDesktop: true,
        platform: "linux",
        fs: {} as never,
        discover,
        resolveHomeFn: async () => "/home/u",
        resolveVendorRootsFn: async () => vendorRoots,
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ vendorRoots }))
    expect(result.current.allowedRoots).toEqual([
      "/proj",
      "/cfg/claude",
      "/cfg/codex",
      "/xdg/opencode",
      "/cfg/pi",
    ])
  })

  it("surfaces an error when the home dir cannot be resolved", async () => {
    const discover = jest.fn()
    const { result } = renderHook(() =>
      useExternalMemory({ isDesktop: true, discover, resolveHomeFn: async () => null })
    )
    await waitFor(() => expect(result.current.error).toBe("home-unresolved"))
    expect(discover).not.toHaveBeenCalled()
  })

  it("uses the real fs adapter + Tauri home resolver when nothing is injected", async () => {
    const { result } = renderHook(() => useExternalMemory({ isDesktop: true, platform: "macos" }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // The always-present user (CLAUDE.md) + global (AGENTS.md) slots come back.
    expect(result.current.files.length).toBeGreaterThan(0)
    expect(result.current.allowedRoots).toEqual(
      expect.arrayContaining(["/Users/x/.claude", "/Users/x/.codex"])
    )
  })

  it("defaults desktop detection to isTauri() (false in tests → unsupported)", () => {
    const { result } = renderHook(() => useExternalMemory())
    expect(result.current.unsupported).toBe(true)
  })

  it("stringifies a non-Error discovery failure", async () => {
    const discover = jest.fn().mockRejectedValue("boom")
    const { result } = renderHook(() =>
      useExternalMemory({
        isDesktop: true,
        fs: {} as never,
        discover,
        resolveHomeFn: async () => "/Users/x",
      })
    )
    await waitFor(() => expect(result.current.error).toBe("boom"))
  })

  it("re-runs discovery on refresh", async () => {
    const discover = jest.fn().mockResolvedValue([])
    const { result } = renderHook(() =>
      useExternalMemory({
        isDesktop: true,
        fs: {} as never,
        discover,
        resolveHomeFn: async () => "/Users/x",
      })
    )
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(1))
    act(() => result.current.refresh())
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2))
  })
})
