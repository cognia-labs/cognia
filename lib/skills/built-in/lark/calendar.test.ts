jest.mock("./_helpers", () => ({ ...jest.requireActual("./_helpers"), runLarkCli: jest.fn() }))
import { runLarkCli } from "./_helpers"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./calendar"

it("registers the certified Lark Calendar skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.calendar")
  expect(skills).toHaveLength(10)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})

it("passes the turn context to Lark authentication", async () => {
  const skill = getSharedBuiltInSkillRegistry().get("lark.calendar.agenda_today")!
  const context = { sessionId: "im-session", actingSenders: "unknown" as const }
  await skill.execute(skill.inputSchema.parse({}), context)
  expect(runLarkCli).toHaveBeenCalledWith(expect.objectContaining({ context }))
})
