/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { Project } from "@/types"

const mockProjects: Array<Pick<Project, "id" | "roots">> = [
  { id: "p1", roots: [{ id: "r1", path: "/repos/app", isPrimary: true }] } as never,
  {
    id: "p2",
    roots: [
      { id: "r1", path: "/repos/app", isPrimary: true },
      { id: "r2", path: "/repos/sdk" },
    ],
  } as never,
]
let trustEnabled = true

// `mock`-prefixed so the hoisted `jest.mock` factory may close over it — a
// plain const here is in the temporal dead zone when the factory runs.
const mockUpdateProject = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ projects: mockProjects }),
    { getState: () => ({ projects: mockProjects, updateProject: mockUpdateProject }) }
  ),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { workspaceTrust: { enabled: trustEnabled } } }),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

import {
  useOtherRepositoriesNeedAttention,
  useRepoWorkspaceConfig,
} from "./use-repo-workspace-config"
import { parseWorkspaceConfig } from "@/lib/project-environment/workspace-config"
import { workspaceConfigDigest } from "@/lib/project-environment/workspace-config-trust"

const CONFIG = { version: 1, setup: { default: "pnpm install" } }

function deps(over: Record<string, unknown> = {}) {
  return {
    readFile: jest.fn(async () => JSON.stringify(CONFIG)),
    isRestricted: jest.fn(async () => false),
    approvedDigestFor: jest.fn(async () => undefined),
    approve: jest.fn(async () => true),
    // Injected so the seeding half never reaches Dexie from a component test.
    trustRecord: jest.fn(async () => undefined),
    recordSeeded: jest.fn(async () => true),
    applyToWorkspace: mockUpdateProject,
    ...over,
  }
}

beforeEach(() => {
  trustEnabled = true
  mockUpdateProject.mockClear()
})

describe("useRepoWorkspaceConfig", () => {
  it("reports a pending approval and the configuration behind it", async () => {
    const { result } = renderHook(() => useRepoWorkspaceConfig("p1", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.verdict.kind).toBe("unapproved")
    expect(result.current.approvalKey).toBe("/repos/app")
  })

  it("records the approval against the workspace's primary root", async () => {
    const digest = await workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
    const approve = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig("p1", "/repos/.wt/feature", deps({ approve }))
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.approve()
    })
    // The content goes with the digest, so a later change can be shown as one.
    expect(approve).toHaveBeenCalledWith(
      "/repos/app",
      digest,
      parseWorkspaceConfig(JSON.stringify(CONFIG))
    )
  })

  /**
   * A browser with no paired host cannot read the file. Trying produced an
   * "invalid" verdict that read as a broken repository; it now reads nothing
   * and says why.
   */
  it("reads nothing where this runtime cannot read files, and says why", async () => {
    const readFile = jest.fn(async () => JSON.stringify(CONFIG))
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig(
        "p1",
        "/repos/app",
        deps({ readFile, readGate: { available: false, reason: "Pair a host to read files." } })
      )
    )
    expect(result.current.unavailable).toBe("Pair a host to read files.")
    expect(result.current.loading).toBe(false)
    expect(result.current.verdict.kind).toBe("absent")
    await act(async () => {
      await Promise.resolve()
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("re-reads after approving instead of assuming it worked", async () => {
    // The file can change between the render and the click; claiming an
    // approval the gate would not agree with is the whole failure this exists
    // to prevent.
    const approvedDigestFor = jest.fn(async () => undefined)
    const d = deps({ approvedDigestFor })
    const { result } = renderHook(() => useRepoWorkspaceConfig("p1", "/repos/app", d))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = approvedDigestFor.mock.calls.length
    await act(async () => {
      await result.current.approve()
    })
    await waitFor(() => expect(approvedDigestFor.mock.calls.length).toBeGreaterThan(before))
  })

  it("refuses to approve anything but a pending verdict", async () => {
    const approve = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig(
        "p1",
        "/repos/app",
        deps({ approve, isRestricted: jest.fn(async () => true) })
      )
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("restricted"))
    await act(async () => {
      await result.current.approve()
    })
    expect(approve).not.toHaveBeenCalled()
  })

  it("surfaces a read failure as invalid rather than as no configuration", async () => {
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig("p1", "/repos/app", deps({ readFile: jest.fn(async () => "{{{") }))
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("invalid"))
  })

  it("re-reads when the execution root moves", async () => {
    const readFile = jest.fn(async () => JSON.stringify(CONFIG))
    const d = deps({ readFile })
    const { rerender, result } = renderHook(
      ({ root }: { root: string }) => useRepoWorkspaceConfig("p1", root, d),
      { initialProps: { root: "/repos/app" } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    const first = readFile.mock.calls.length
    rerender({ root: "/repos/.wt/feature" })
    await waitFor(() => expect(readFile.mock.calls.length).toBeGreaterThan(first))
  })

  it("has no approval key for a workspace it cannot find", async () => {
    const { result } = renderHook(() => useRepoWorkspaceConfig("gone", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.approvalKey).toBeNull()
  })
})

describe("seeding what the repository declares", () => {
  const DECLARING = {
    version: 1,
    roots: [
      { id: "app", path: ".", role: "primary" },
      { id: "web", path: "packages/web", role: "additional" },
    ],
    capabilities: { mcpServer: { jira: true } },
  }

  function declaringDeps(over: Record<string, unknown> = {}) {
    return deps({ readFile: jest.fn(async () => JSON.stringify(DECLARING)), ...over })
  }

  it("applies the declared roots and capabilities the moment the user approves", async () => {
    const recordSeeded = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig("p1", "/repos/app", declaringDeps({ recordSeeded }))
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("unapproved"))
    await act(async () => {
      await result.current.approve()
    })
    expect(mockUpdateProject).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        capabilityOverlay: { mcpServer: { jira: true } },
        roots: expect.arrayContaining([
          expect.objectContaining({ path: "/repos/app/packages/web" }),
        ]),
      })
    )
    // The seed record and the thing it seeded are one decision.
    expect(recordSeeded).toHaveBeenCalledWith(
      "/repos/app",
      expect.arrayContaining(["cap:mcpServer:jira", "root:web"])
    )
  })

  it("does not re-offer a declaration the user already answered", async () => {
    const recordSeeded = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig(
        "p1",
        "/repos/app",
        declaringDeps({
          recordSeeded,
          trustRecord: jest.fn(async () => ({
            path: "/repos/app",
            trustedAt: 1,
            seededDeclarations: ["cap:mcpServer:jira", "root:web"],
          })),
        })
      )
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("unapproved"))
    await act(async () => {
      await result.current.approve()
    })
    expect(mockUpdateProject).not.toHaveBeenCalled()
    expect(recordSeeded).not.toHaveBeenCalled()
  })

  it("writes nothing when the repository declares nothing to seed", async () => {
    const recordSeeded = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig("p1", "/repos/app", deps({ recordSeeded }))
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("unapproved"))
    await act(async () => {
      await result.current.approve()
    })
    expect(mockUpdateProject).not.toHaveBeenCalled()
    expect(recordSeeded).not.toHaveBeenCalled()
  })
})

describe("another repository of the workspace (ADR-0147, 2026-11-08 amendment)", () => {
  it("reads and approves the file at its own root, never under the primary's key", async () => {
    const digest = await workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
    const approve = jest.fn(async () => true)
    const approvedDigestFor = jest.fn(async (path: string) =>
      // The primary has approved its own file; that must not count here.
      path === "/repos/app" ? digest : undefined
    )
    const readFile = jest.fn(async () => JSON.stringify(CONFIG))
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig("p2", "/repos/sdk", deps({ approve, approvedDigestFor, readFile }), {
        approvalRoot: "/repos/sdk",
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.approvalKey).toBe("/repos/sdk")
    expect(result.current.verdict.kind).toBe("unapproved")
    expect(readFile).toHaveBeenCalledWith("/repos/sdk", expect.any(String), expect.any(Number))
    await act(async () => {
      await result.current.approve()
    })
    expect(approve).toHaveBeenCalledWith("/repos/sdk", digest, expect.anything())
  })

  it("seeds nothing into the workspace from another repository's file", async () => {
    // Its roots and capabilities would land on the whole workspace, and its
    // seeded root ids could collide with the primary's.
    const seeding = {
      version: 1,
      roots: [{ id: "docs", path: "docs" }],
      capabilities: { mcpServer: { jira: true } },
    }
    const recordSeeded = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig(
        "p2",
        "/repos/sdk",
        deps({ readFile: jest.fn(async () => JSON.stringify(seeding)), recordSeeded }),
        { approvalRoot: "/repos/sdk" }
      )
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("unapproved"))
    await act(async () => {
      await result.current.approve()
    })
    expect(mockUpdateProject).not.toHaveBeenCalled()
    expect(recordSeeded).not.toHaveBeenCalled()
  })

  it("flags another repository whose file waits for a decision", async () => {
    const approvedDigestFor = jest.fn(async () => undefined)
    const { result } = renderHook(() =>
      useOtherRepositoriesNeedAttention(
        "p2",
        deps({ approvedDigestFor, readGate: { available: true, reason: null } }) as never
      )
    )
    await waitFor(() => expect(result.current).toBe(true))
    expect(approvedDigestFor).toHaveBeenCalledWith("/repos/sdk")
    expect(approvedDigestFor).not.toHaveBeenCalledWith("/repos/app")
  })

  it("stays quiet once that repository's file is approved, and for one repository", async () => {
    const digest = await workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
    const approved = deps({
      approvedDigestFor: jest.fn(async () => digest),
      readGate: { available: true, reason: null },
    }) as never
    const multi = renderHook(() => useOtherRepositoriesNeedAttention("p2", approved))
    const single = renderHook(() => useOtherRepositoriesNeedAttention("p1", approved))
    // Let the read settle before asserting it found nothing to flag.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(multi.result.current).toBe(false)
    expect(single.result.current).toBe(false)
  })
})
