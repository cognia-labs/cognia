jest.mock("./_helpers", () => ({ ...jest.requireActual("./_helpers"), runLarkCli: jest.fn() }))
import { runLarkCli } from "./_helpers"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./wiki"

it("registers the certified Lark Wiki skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.wiki")
  expect(skills).toHaveLength(4)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})

it("passes the turn context to Lark authentication", async () => {
  const skill = getSharedBuiltInSkillRegistry().get("lark.wiki.search_nodes")!
  const context = { sessionId: "im-session", actingSenders: "unknown" as const }
  await skill.execute(skill.inputSchema.parse({ query: "test" }), context)
  expect(runLarkCli).toHaveBeenCalledWith(expect.objectContaining({ context }))
})
