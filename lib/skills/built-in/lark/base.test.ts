jest.mock("./_helpers", () => ({ ...jest.requireActual("./_helpers"), runLarkCli: jest.fn() }))
import { runLarkCli } from "./_helpers"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./base"

it("registers the certified Lark Base skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.base")
  expect(skills).toHaveLength(8)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})

it("routes the chosen connection while preserving the turn context", async () => {
  const skill = getSharedBuiltInSkillRegistry().get("lark.base.list_tables")!
  const context = { sessionId: "im-session", actingSenders: "unknown" as const }
  await skill.execute(
    skill.inputSchema.parse({ appToken: "app", adapterId: "cai_school" }),
    context
  )
  expect(runLarkCli).toHaveBeenCalledWith(
    expect.objectContaining({
      adapterId: "cai_school",
      context: { ...context, larkAdapterId: "cai_school" },
    })
  )
  expect((runLarkCli as jest.Mock).mock.calls[0][0].args).not.toContain("--adapter-id")
  expect(context).not.toHaveProperty("larkAdapterId")
})
