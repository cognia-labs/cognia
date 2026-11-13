import {
  bindPersonalOperationOrigin,
  bindPersonalOperationSources,
  copyPersonalOperation,
  personalOperationSources,
  forkPersonalOperation,
  isPersonalAdmissionOperation,
  personalOperationToolIds,
} from "./personal-operation"
it("H3: excludes its own stack and stream but never a sibling or another Host", () => {
  const root = bindPersonalOperationOrigin(
    { executionRunId: "run" },
    { sessionId: "s", toolUseId: "native", scope: "local" }
  )
  const current = forkPersonalOperation(root),
    sibling = forkPersonalOperation(root)
  const stream = forkPersonalOperation(current)
  expect(isPersonalAdmissionOperation(root, current)).toBe(true)
  expect(isPersonalAdmissionOperation(stream, current)).toBe(false)
  expect(isPersonalAdmissionOperation(stream, stream)).toBe(true)
  expect(isPersonalAdmissionOperation(sibling, current)).toBe(false)
  expect(isPersonalAdmissionOperation(forkPersonalOperation(current), current)).toBe(false)
  expect(isPersonalAdmissionOperation({ ...current }, current)).toBe(true)
  expect(isPersonalAdmissionOperation(JSON.parse(JSON.stringify(current)), current)).toBe(false)
  expect(personalOperationToolIds(current, "s", "local")).toEqual(["native"])
  expect(personalOperationToolIds(current, "s", "another-host")).toEqual([])
})

it("keeps concurrent producer dependencies Host-only across callback forks", () => {
  const sources = [{ executionRunId: "producer-a" }, { executionRunId: "producer-b" }]
  const context = bindPersonalOperationSources({ executionRunId: "" }, sources)
  expect(context).toEqual({ executionRunId: "" })
  expect(personalOperationSources(forkPersonalOperation(context))).toBe(sources)
  expect(personalOperationSources(copyPersonalOperation(context, {}))).toBe(sources)
  expect(personalOperationSources(JSON.parse(JSON.stringify(context)))).toBeUndefined()
})

it("S2 retains only the actual rejected callback producer", async () => {
  const { retainPersonalFailure, personalFailureSource } = await import("./personal-operation")
  const source = { executionRunId: "producer" }
  const failure = retainPersonalFailure("private failure", source)
  expect(failure).toBeInstanceOf(Error)
  expect(personalFailureSource(failure)).toBe(source)
  expect(personalFailureSource(new Error("private failure"))).toBeUndefined()
})

it("dispatch snapshot configuration preserves the dependency-free background path", async () => {
  const { configurePersonalDispatchFence, cachedPersonalDispatchFence } =
    await import("./personal-operation")
  const restore = configurePersonalDispatchFence(() => true)
  try {
    expect(cachedPersonalDispatchFence({})).toBe(false)
    expect(cachedPersonalDispatchFence({ executionRunId: "run" })).toBe(true)
  } finally {
    restore()
  }
})

it("R11 derived session provenance is not treated as background", async () => {
  const { configurePersonalDispatchFence, cachedPersonalDispatchFence } =
    await import("./personal-operation")
  const read = jest.fn(() => undefined)
  const restore = configurePersonalDispatchFence(read)
  try {
    const context = { sessionId: "branch", sessionDerived: true }
    expect(cachedPersonalDispatchFence(context)).toBeUndefined()
    expect(read).toHaveBeenCalledWith(context)
  } finally {
    restore()
  }
})
