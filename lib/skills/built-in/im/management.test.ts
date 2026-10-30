import "./management"
import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
jest.mock("./_helpers", () => ({ resolveChatCapableAdapter: jest.fn() }))
import { resolveChatCapableAdapter } from "./_helpers"
const getBuiltInSkill = (id: string) => getSharedBuiltInSkillRegistry().get(id)

it("registers distinct read and confirmed mutation entries", () => {
  expect(getBuiltInSkill("im.query_resource")).toMatchObject({
    mutation: "read",
    imAccess: "opt-in",
  })
  expect(getBuiltInSkill("im.manage_resource")).toMatchObject({
    mutation: "destructive",
    imAccess: "opt-in",
  })
  const read = getBuiltInSkill("im.query_resource")!
  expect(read.inputSchema.safeParse({ operation: "members.remove", input: {} }).success).toBe(false)
})
it("offers link creation through the existing confirmed management tool", async () => {
  const skill = getBuiltInSkill("im.manage_resource")!
  const args = {
    adapterId: "links",
    operation: "links.create",
    input: { purpose: "add-contact", state: "campaign" },
  }
  expect(skill.inputSchema.safeParse(args).success).toBe(true)
  expect(getBuiltInSkill("im.query_resource")!.inputSchema.safeParse(args).success).toBe(false)
  expect(skill.hitlSurface).toBeDefined()
  const execute = jest.fn(async () => ({
    status: "ok" as const,
    link: { purpose: "add-contact", url: "https://example.org/invite" },
  }))
  jest.mocked(resolveChatCapableAdapter).mockResolvedValue({
    adapterId: "links",
    platform: "matrix",
    adapter: {
      id: "links",
      meta: { capabilities: ["links.create"] },
      health: () => ({ state: "running" }),
      management: { operations: ["links.create"], execute },
    } as never,
  })
  await skill.preflight!(args, {} as BuiltInSkillContext)
  expect(resolveChatCapableAdapter).toHaveBeenLastCalledWith({}, ["links.create"], "links")
  await expect(skill.execute(args, {} as BuiltInSkillContext)).resolves.toMatchObject({
    link: { purpose: "add-contact" },
  })
  expect(execute).toHaveBeenCalledWith({ operation: "links.create", input: args.input })
})
it("dispatches through the shared capability and running adapter contract", async () => {
  const execute = jest.fn(async () => ({ status: "ok" as const, assets: [] }))
  jest.mocked(resolveChatCapableAdapter).mockResolvedValue({
    adapterId: "a",
    platform: "matrix",
    adapter: {
      id: "a",
      meta: { capabilities: ["assets.manage"] },
      health: () => ({ state: "running" }),
      management: { operations: ["assets.list"], execute },
    } as never,
  })
  const skill = getBuiltInSkill("im.query_resource")!
  expect(
    await skill.execute(
      { operation: "assets.list", input: {}, adapterId: "a" },
      {} as BuiltInSkillContext
    )
  ).toMatchObject({ status: "ok" })
  expect(resolveChatCapableAdapter).toHaveBeenCalledWith({}, ["assets.manage"], "a")
  expect(execute).toHaveBeenCalledWith({ operation: "assets.list", input: {} })
})
