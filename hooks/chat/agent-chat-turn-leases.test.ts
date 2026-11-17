import { desktopTurnLeases, type DesktopTurnLease } from "./agent-chat-turn-leases"

afterEach(() => desktopTurnLeases.clear())

it("is one registry for every importer, so Stop sees the lease Send took", async () => {
  const lease: DesktopTurnLease = { pendingDispatches: 1, settle: jest.fn() }
  desktopTurnLeases.set("session:chat", lease)

  const again = await import("./agent-chat-turn-leases")

  expect(again.desktopTurnLeases).toBe(desktopTurnLeases)
  expect(again.desktopTurnLeases.get("session:chat")).toBe(lease)
})
