/** @jest-environment jsdom */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as ts from "typescript"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { addPersonalMarksToRun, bindPersonalMessageRun } from "@/lib/execution/personal-marks"
import { withPluginPersonalReads } from "./personal-read-projection"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("P1 session reads and subscriptions withhold real marked rows with no personal reader", async () => {
  const db = getDb()
  await db.sessions.put({ id: "p1", title: "Session", createdAt: 1, updatedAt: 1 } as never)
  await db.sessions.put({ id: "p1-clean", title: "Clean", createdAt: 1, updatedAt: 1 } as never)
  const run = await startToolExecutionRun("p1", { localAuthorization: LOCAL_PERSON_RUN })
  const mark = { person: { kind: "local-person" as const }, source: "P1", markedAt: 1 }
  await addPersonalMarksToRun({ executionRunId: run.id }, [mark])
  const rows = [
    {
      id: "secret",
      sessionId: "p1",
      role: "assistant",
      parts: [{ type: "text", text: "private transcript" }],
      metadata: { personalMarkVersion: 1, toolResult: "private attachment" },
    },
    {
      id: "clean",
      sessionId: "p1-clean",
      role: "user",
      parts: [{ type: "text", text: "public text" }],
      metadata: { personalMarkVersion: 1 },
    },
  ]
  bindPersonalMessageRun("secret", run.id)
  await db.messages.bulkPut(rows as never)
  let emit!: (messages: typeof rows) => void
  const unsubscribe = jest.fn()
  const api = withPluginPersonalReads({
    session: {
      getMessages: async (_sessionId: string) => rows,
      onMessagesChange: (_sessionId: string, callback: typeof emit) => {
        emit = callback
        return unsubscribe
      },
    },
  })
  const result = await api.session.getMessages("p1")
  expect(JSON.stringify(result[0])).not.toContain("private")
  expect(result[0].parts[0].text).toContain("Withheld")
  expect(result[1]).toEqual(rows[1])
  const { createSessionAPI } = await import("@/lib/plugin/api/session-api")
  const { getPermissionGuard } = await import("@/lib/plugin/security/permission-guard")
  const guard = getPermissionGuard({ confirmDangerousByDefault: false })
  guard.registerPlugin("p1-real-api", ["session:read"])
  try {
    const actual = withPluginPersonalReads({ session: createSessionAPI("p1-real-api") })
    const messages = await actual.session.getMessages("p1")
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages[0])).not.toContain("private")
    const clean = await actual.session.getMessages("p1-clean")
    expect(clean[0].content).toBe("public text")
    const changed = jest.fn()
    const stop = actual.session.onMessagesChange("p1", changed)
    while (!changed.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.stringify(changed.mock.calls[0][0][0])).not.toContain("private")
    expect(changed.mock.calls[0][0]).toHaveLength(1)
    stop()
  } finally {
    guard.unregisterPlugin("p1-real-api")
  }
  const received = jest.fn()
  const off = api.session.onMessagesChange("p1", received)
  emit(rows)
  while (!received.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(received.mock.calls[0][0]).toEqual(result)
  emit(rows)
  off()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(received).toHaveBeenCalledTimes(1)
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it("Q1 clean metadata, no-provenance values and derived artifacts remain unchanged", async () => {
  const row = { id: "a", title: "Clean title", content: "body", versions: [{ text: "history" }] }
  const ctx = withPluginPersonalReads({
    session: { getCurrentSession: () => row, listSessions: async () => [row] },
    artifact: { getActiveArtifact: () => row },
    canvas: { getContent: () => "canvas" },
    logs: { query: async () => [row] },
    agent: { invokeTool: async () => 12345, run: async () => ({ text: "public" }) },
  })
  expect(ctx.session.getCurrentSession()).toEqual(row)
  expect(await ctx.session.listSessions()).toEqual([row])
  expect(ctx.artifact.getActiveArtifact()).toBe(row)
  expect(ctx.canvas.getContent()).toBe("canvas")
  expect(await ctx.logs.query()).toEqual([row])
  expect(await ctx.agent.invokeTool()).toBe(12345)
  expect(await ctx.agent.run()).toEqual({ text: "public" })
})

it("Q1 only positively marked run outputs are withheld", async () => {
  const run = await startToolExecutionRun("q1-output", { localAuthorization: LOCAL_PERSON_RUN })
  const ctx = withPluginPersonalReads(
    {
      agent: {
        run: async () => ({ text: "output" }),
        invokeTool: async () => ({ agentId: "fake-clean", text: "private tool" }),
      },
    },
    () => ({ executionRunId: run.id })
  )
  expect((await ctx.agent.run()).text).toBe("output")
  await addPersonalMarksToRun({ executionRunId: run.id }, [
    { person: { kind: "local-person" }, source: "Q1", markedAt: 1 },
  ])
  expect(JSON.stringify(await ctx.agent.run())).not.toContain('"output"')
  expect(JSON.stringify(await ctx.agent.invokeTool())).not.toContain("private tool")
})

it("Q1 sync session metadata survives while a positively marked branch transcript is withheld", () => {
  const session = {
    id: "seed",
    title: "Visible title",
    branchSeed: {
      kind: "transcript",
      content: "private seed",
      personalMarks: [{ person: { kind: "local-person" }, source: "Q1", markedAt: 1 }],
    },
  }
  const ctx = withPluginPersonalReads({ session: { getCurrentSession: () => session } })
  const result = ctx.session.getCurrentSession()
  expect(result.title).toBe("Visible title")
  expect(JSON.stringify(result.branchSeed)).not.toContain("private seed")
})

it("R11 every ctx.agent runner member projects marked invocation output, including executeAgent", async () => {
  const source = ts.createSourceFile(
    "context.ts",
    readFileSync(join(__dirname, "context.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const factory = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "createAgentAPI"
  )
  expect(factory?.body).toBeDefined()
  const returned = factory!.body!.statements.find(ts.isReturnStatement)?.expression
  if (!returned || !ts.isObjectLiteralExpression(returned))
    throw new Error("Missing ctx.agent factory")
  const runners = new Set([
    "runPluginAgent",
    "runPluginAgentStreamed",
    "runPluginAgentTurn",
    "runPluginExternalAgent",
    "invokePluginTool",
    "runWebBuiltinTool",
    "dispatchSubagentAsChildRun",
    "runTeam",
  ])
  const methods: string[] = []
  for (const property of returned.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    let reaches = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        runners.has(node.expression.text)
      )
        reaches = true
      ts.forEachChild(node, visit)
    }
    visit(property.initializer)
    if (reaches) {
      if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
        throw new Error("Unsupported runner-bearing member")
      methods.push(property.name.text)
    }
  }
  expect(methods).toContain("executeAgent")
  const run = await startToolExecutionRun("r11-structural", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const raw = { agentId: "r11-external-instance", text: "r11 private runner output" }
  const agent = Object.fromEntries(methods.map((name) => [name, async () => raw])) as Record<
    string,
    () => Promise<typeof raw>
  >
  const ctx = withPluginPersonalReads({ agent }, () => ({ executionRunId: run.id }))
  for (const name of methods) expect(await ctx.agent[name]()).toEqual(raw)
  await addPersonalMarksToRun({ executionRunId: run.id }, [
    { person: { kind: "local-person" }, source: "R11", markedAt: 1 },
  ])
  for (const name of methods)
    expect({ name, leaked: JSON.stringify(await ctx.agent[name]()).includes(raw.text) }).toEqual({
      name,
      leaked: false,
    })
})
it("R11 synchronous agent registration preserves its adapter factory", () => {
  let factory!: () => object
  const adapter = { protocol: "test" }
  const ctx = withPluginPersonalReads({
    agent: {
      registerExternalAgentAdapter: (value: () => object) => {
        factory = value
        return () => undefined
      },
    },
  })
  const dispose = ctx.agent.registerExternalAgentAdapter(() => adapter)
  expect(factory()).toBe(adapter)
  expect(dispose()).toBeUndefined()
})
