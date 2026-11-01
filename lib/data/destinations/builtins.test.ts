import "./builtins"
import { listBackupDestinations, withBackupDestination } from "./registry"

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
