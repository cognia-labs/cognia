import "./builtins"
import { listBackupDestinations, withBackupDestination } from "./registry"
import * as registry from "./registry"

it("re-evaluates built-ins without replacing destinations or cancelling an active backup", async () => {
  const before = listBackupDestinations()
  const revision = registry.getBackupDestinationRevision()
  let finish!: () => void
  let active!: AbortSignal
  const pending = withBackupDestination("webdav", undefined, async (_entry, signal) => {
    active = signal
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return "uploaded"
  })
  try {
    // Fast Refresh can re-evaluate the initializer while retaining its registry.
    jest.doMock("./registry", () => registry)
    expect(() => {
      jest.isolateModules(() => jest.requireActual("./builtins"))
    }).not.toThrow()
    expect(listBackupDestinations()).toHaveLength(before.length)
    for (const entry of before) expect(registry.getBackupDestination(entry.id)).toBe(entry)
    expect(registry.getBackupDestinationRevision()).toBe(revision)
    expect(active.aborted).toBe(false)
  } finally {
    jest.dontMock("./registry")
    finish()
    await expect(pending).resolves.toBe("uploaded")
  }
})

it("registers all three built-ins through the public descriptor with cancellable calls", async () => {
  const builtins = listBackupDestinations().filter((entry) => !entry.pluginId)
  expect(builtins.map((entry) => entry.id)).toEqual(["webdav", "github", "googledrive"])
  for (const entry of builtins) {
    expect(typeof entry.readiness).toBe("function")
    expect(typeof entry.upload).toBe("function")
    const controller = new AbortController()
    controller.abort()
    const invoke = jest.fn()
    await expect(withBackupDestination(entry.id, controller.signal, invoke)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(invoke).not.toHaveBeenCalled()
  }
})

jest.mock("./config", () => ({
  ...jest.requireActual("./config"),
  getBackupDestinationsSettings: jest.fn(),
}))
jest.mock("./google-oauth", () => ({ resolveGoogleDriveConnection: jest.fn() }))
jest.mock("@/lib/docs-providers/providers/google/state", () => ({ googleState: jest.fn() }))
import { getBackupDestinationsSettings } from "./config"
import { resolveGoogleDriveConnection } from "./google-oauth"
import { googleState } from "@/lib/docs-providers/providers/google/state"

it.each([
  [undefined, false, false, "needs-setup"],
  ["backup", false, false, "needs-setup"],
  ["backup", true, false, "needs-auth"],
  ["backup", true, true, "ready"],
] as const)(
  "Drive readiness uses client secret metadata and its bound connection: %s %s %s",
  async (clientId, secret, bound, state) => {
    jest
      .mocked(getBackupDestinationsSettings)
      .mockResolvedValue({ googleDrive: { enabled: true, clientId } })
    jest
      .mocked(resolveGoogleDriveConnection)
      .mockResolvedValue(bound ? ({ id: "private-reference" } as never) : null)
    jest
      .mocked(googleState)
      .mockResolvedValue({ clients: [{ clientId: "backup", hasClientSecret: secret }] } as never)
    const entry = listBackupDestinations().find((value) => value.id === "googledrive")!
    const result = await entry.readiness(new AbortController().signal)
    expect(result).toEqual(state === "ready" ? { state } : { state, reasonKey: "googledrive" })
    expect(JSON.stringify(result)).not.toContain("private-reference")
    expect(entry.list).toBeDefined()
    expect(entry.download).toBeDefined()
  }
)
