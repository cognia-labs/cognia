jest.mock("@/lib/scm/runtime", () => ({ createScmRuntime: jest.fn() }))
import { createScmRuntime } from "@/lib/scm/runtime"
import { checkBestOfNHead } from "./checks"
import type { AgentChangeset } from "@/lib/scm/types"
import type { BestOfNGroup } from "@/types/best-of-n"

const group = { groupId: "g", repositoryId: "repo", sourceRoot: "/source" } as BestOfNGroup
const changeset = {
  changesetId: "cs",
  headSha: "pinned",
  sourceRoot: "/source",
  executionRoot: "/dirty-attempt",
} as AgentChangeset
beforeEach(() => jest.clearAllMocks())

it("reuses generic exact-head verification with source approvals and no AI reviewer", async () => {
  const review = jest.fn().mockResolvedValue({ changeset, checks: [], policy: null })
  jest.mocked(createScmRuntime).mockReturnValue({ review } as never)
  const host = { getChangeset: jest.fn().mockResolvedValue(changeset) }
  const signal = new AbortController().signal
  await checkBestOfNHead(group, changeset, "project", host as never, signal)
  const input = jest.mocked(createScmRuntime).mock.calls[0][0]
  expect(input.appSettings).toBeNull()
  expect(input.configRoot).toBe("/source")
  expect(input.projectId).toBe("project")
  expect(await input.host!.getChangeset("cs")).toBe(changeset)
  expect(review).toHaveBeenCalledWith("cs", signal)
})

it("refuses a head that moved before generic verification", async () => {
  jest
    .mocked(createScmRuntime)
    .mockImplementation((input) => ({ review: () => input.host!.getChangeset("cs") }) as never)
  const host = { getChangeset: jest.fn().mockResolvedValue({ ...changeset, headSha: "moved" }) }
  await expect(
    checkBestOfNHead(group, changeset, "project", host as never, new AbortController().signal)
  ).rejects.toThrow("head changed")
})

it("does not start review when already cancelled", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    checkBestOfNHead(group, changeset, null, {} as never, controller.signal)
  ).rejects.toThrow()
  expect(createScmRuntime).not.toHaveBeenCalled()
})
