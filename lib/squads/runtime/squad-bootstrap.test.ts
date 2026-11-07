const mockDispose = jest.fn()
let mockResolveDone: (outcome: { ok: boolean; failedStage?: string }) => void = () => {}
const mockRunSquadBootstrap = jest.fn(() => ({
  done: new Promise((resolve) => {
    mockResolveDone = resolve
  }),
  dispose: mockDispose,
}))
jest.mock("@/lib/squads/bootstrap", () => ({
  runSquadBootstrap: () => mockRunSquadBootstrap(),
}))

import { start } from "./squad-bootstrap"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mockDispose.mockClear()
  mockRunSquadBootstrap.mockClear()
})

describe("squad bootstrap runtime", () => {
  it("runs the ordered bootstrap and disposes it on teardown", async () => {
    const teardown = await start({ log: jest.fn() })
    expect(mockRunSquadBootstrap).toHaveBeenCalledTimes(1)
    teardown()
    expect(mockDispose).toHaveBeenCalledTimes(1)
  })

  it("reports a bootstrap that failed at a stage", async () => {
    const log = jest.fn()
    await start({ log })
    mockResolveDone({ ok: false, failedStage: "recover" })
    await flush()
    expect(log).toHaveBeenCalledWith("warn", "agent team bootstrap failed at recover")
  })

  it("stays quiet about a run its own restart superseded", async () => {
    const log = jest.fn()
    const teardown = await start({ log })
    teardown()
    mockResolveDone({ ok: false, failedStage: "hydrate" })
    await flush()
    expect(log).not.toHaveBeenCalled()
  })
})
