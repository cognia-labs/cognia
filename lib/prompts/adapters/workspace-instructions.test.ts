/** @jest-environment jsdom */

const mockPutProject = jest.fn(async (_project: unknown) => {})
jest.mock("@/lib/db/projects", () => ({
  ...jest.requireActual("@/lib/db/projects"),
  putProject: (project: unknown) => mockPutProject(project),
}))

import { WORKSPACE_INSTRUCTIONS_MAX_CHARS } from "@/lib/workspace/workspace-instructions"
import { useProjectStore } from "@/stores/project/project-store"
import { resourceKey } from "../resources"
import { workspaceInstructionsPromptAdapter as adapter } from "./workspace-instructions"

const KEY = resourceKey("workspace-instructions", "ws-1")
const ctx = { workspace: { id: "ws-1", name: "Repo", roots: ["/repo"] } }

function seed(customInstructions?: string) {
  useProjectStore.setState({
    loaded: true,
    projects: [{ id: "ws-1", name: "Repo (store)", customInstructions, roots: ["/repo"] }],
  } as never)
}

beforeEach(() => {
  mockPutProject.mockReset().mockResolvedValue(undefined)
  seed()
})

describe("workspaceInstructionsPromptAdapter", () => {
  it("lists nothing without a workspace and one entry with one", async () => {
    expect(await adapter.list({})).toEqual([])
    seed("Use pnpm.")
    expect(await adapter.list(ctx)).toEqual([
      {
        key: KEY,
        source: "workspace-instructions",
        kind: "project-rule",
        operation: "append-rules",
        name: "Repo (store)",
        builtIn: false,
        modified: true,
        edit: "source",
      },
    ])
  })

  it("saves through the project store, clearing on blank text", async () => {
    expect(await adapter.save!(KEY, "  Use pnpm.  ", undefined, ctx)).toEqual({
      key: KEY,
      text: "Use pnpm.",
    })
    expect(useProjectStore.getState().projects[0].customInstructions).toBe("Use pnpm.")
    await adapter.save!(KEY, "   ", undefined, ctx)
    expect(useProjectStore.getState().projects[0].customInstructions).toBeUndefined()
    expect((await adapter.read(KEY, ctx))?.text).toBe("")
  })

  it("writes the row before reporting the save", async () => {
    await adapter.save!(KEY, "Use pnpm.", undefined, ctx)
    expect(mockPutProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-1", customInstructions: "Use pnpm." })
    )
  })

  // F13: the save used to resolve with the new text while the write failed.
  it("fails the save when the row cannot be written, keeping the stored text", async () => {
    seed("Old.")
    mockPutProject.mockRejectedValueOnce(
      Object.assign(new Error("quota"), { name: "QuotaExceededError" })
    )
    await expect(adapter.save!(KEY, "New.", undefined, ctx)).rejects.toThrow("quota")
    expect(useProjectStore.getState().projects[0].customInstructions).toBe("Old.")
    expect((await adapter.read(KEY, ctx))?.text).toBe("Old.")
  })

  it("refuses a workspace known only from the context, which it cannot write", async () => {
    useProjectStore.setState({ projects: [] } as never)
    await expect(adapter.save!(KEY, "x", undefined, ctx)).rejects.toThrow("not found")
  })

  it("refuses text over the workspace limit and an unknown workspace", async () => {
    await expect(
      adapter.save!(KEY, "x".repeat(WORKSPACE_INSTRUCTIONS_MAX_CHARS + 1), undefined, ctx)
    ).rejects.toThrow("limited")
    const other = resourceKey("workspace-instructions", "ws-2")
    await expect(adapter.save!(other, "x", undefined, ctx)).rejects.toThrow("not found")
    expect(await adapter.read(other, ctx)).toBeUndefined()
  })

  it("reads a workspace the store does not hold from the context", async () => {
    useProjectStore.setState({ projects: [] } as never)
    expect(
      await adapter.read(KEY, { workspace: { ...ctx.workspace, customInstructions: "From ctx." } })
    ).toEqual({ key: KEY, text: "From ctx." })
  })
})
