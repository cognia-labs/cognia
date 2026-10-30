jest.mock("./_helpers", () => ({ ...jest.requireActual("./_helpers"), runLarkCli: jest.fn() }))
import { runLarkCli } from "./_helpers"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./sheets"

it("registers the certified Lark Sheets skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.sheets")
  expect(skills).toHaveLength(7)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})

it("passes the turn context to Lark authentication", async () => {
  const skill = getSharedBuiltInSkillRegistry().get("lark.sheets.read_range")!
  const context = { sessionId: "im-session", actingSenders: "unknown" as const }
  await skill.execute(
    skill.inputSchema.parse({ spreadsheetToken: "sheet", sheetId: "tab", range: "A1:B2" }),
    context
  )
  expect(runLarkCli).toHaveBeenCalledWith(expect.objectContaining({ context }))
})
