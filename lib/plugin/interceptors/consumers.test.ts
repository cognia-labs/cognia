import { transformModelStreamPart, decideAgentTurn, projectPluginSurface } from "./consumers"
import type { InterceptorRegistration } from "./types"

const context = (handler: (...args: never[]) => unknown) => ({
  operationId: "run",
  sessionId: "session",
  chain: [
    {
      registrationId: "r",
      pluginId: "p",
      pluginInstanceId: "p#1",
      generation: 1,
      realmId: "global",
      pointId: "model.stream.transform",
      semantic: "transform",
      trustTier: "community",
      order: {},
      timeoutMs: 20,
      source: "interceptors",
      runtime: "frontend",
      handler,
    } as InterceptorRegistration,
  ],
})

it("projects actual text while keeping event identities and tool arguments intact", async () => {
  const options = context((value: never) => ({ ...(value as object), text: "redacted" }))
  expect(
    await transformModelStreamPart({ type: "text-delta", id: "m", text: "private" }, options)
  ).toEqual({ type: "text-delta", id: "m", text: "redacted" })
  const tool = { type: "tool-call", input: { text: "arguments" } }
  expect(await transformModelStreamPart(tool, options)).toBe(tool)
})

it("requires explicit approval and never converts denial into approval", async () => {
  const approve = jest.fn(async () => true)
  await decideAgentTurn(
    { sessionId: "session", step: 1 },
    context(() => ({ decision: "requireApproval", reason: "ask" })),
    approve
  )
  expect(approve).toHaveBeenCalledTimes(1)
  await expect(
    decideAgentTurn(
      { sessionId: "session", step: 2 },
      context(() => ({ decision: "deny", reason: "stop" })),
      approve
    )
  ).rejects.toThrow("stop")
  expect(approve).toHaveBeenCalledTimes(1)
})

it("a human approval never skips a later guard denial", async () => {
  const options = context(() => ({ decision: "requireApproval", reason: "ask" }))
  options.chain.push({
    ...options.chain[0],
    registrationId: "deny",
    handler: (() => ({ decision: "deny", reason: "final deny" })) as never,
  })
  const approve = jest.fn(async () => true)
  await expect(
    decideAgentTurn({ sessionId: "session", step: 0 }, options, approve)
  ).rejects.toThrow("final deny")
  expect(approve).not.toHaveBeenCalled()
})

it("an approval delivery failure becomes typed denial instead of a routing retry", async () => {
  await expect(
    decideAgentTurn(
      { sessionId: "session", step: 0 },
      context(() => ({ decision: "requireApproval", reason: "ask" })),
      async () => {
        throw new Error("delivery failed")
      }
    )
  ).rejects.toMatchObject({ name: "InterceptorGuardDeniedError" })
})

it("validates malformed output within fail-open and narrowed strict policies", async () => {
  const part = { type: "text-delta", text: "original" }
  const options = context((input: never) => ({ ...(input as object), text: 0 }))
  await expect(transformModelStreamPart(part, options)).resolves.toEqual(part)
  options.chain[0].failurePolicy = "fail-closed"
  await expect(transformModelStreamPart(part, options)).rejects.toMatchObject({
    name: "InterceptorFailClosedError",
  })
})

it("consumes presentation only and rejects rewritten owner context under strict policy", async () => {
  const value = {
    point: "toolbar",
    pluginId: "owner",
    extensionId: "ext",
    context: { sessionId: "session" },
    presentation: { hidden: false },
  }
  expect(
    (
      await projectPluginSurface(
        value,
        context((input: never) => ({
          ...(input as object),
          presentation: { hidden: true, title: "Projected" },
        }))
      )
    ).presentation
  ).toEqual({ hidden: true, title: "Projected" })
  const options = context((input: never) => ({ ...(input as object), pluginId: "other" }))
  options.chain[0].failurePolicy = "fail-closed"
  await expect(projectPluginSurface(value, options)).rejects.toThrow()
})
