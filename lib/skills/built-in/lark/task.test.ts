jest.mock("./_helpers", () => ({ ...jest.requireActual("./_helpers"), runLarkCli: jest.fn() }))
import { runLarkCli } from "./_helpers"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./task"

it("registers the certified Lark Task skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.task")
  expect(skills).toHaveLength(8)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})

it("passes the turn context to Lark authentication", async () => {
  const skill = getSharedBuiltInSkillRegistry().get("lark.task.list_my_tasks")!
  const context = { sessionId: "im-session", actingSenders: "unknown" as const }
  await skill.execute(skill.inputSchema.parse({}), context)
  expect(runLarkCli).toHaveBeenCalledWith(expect.objectContaining({ context }))
})
