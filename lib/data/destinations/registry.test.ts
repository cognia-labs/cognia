import {
  readBackupDestinationBody,
  getBackupDestination,
  getBackupDestinationRevision,
  listBackupDestinations,
  registerBackupDestination,
  subscribeBackupDestinations,
  withBackupDestination,
} from "./registry"

const contribution = () => ({
  id: "archive",
  label: "Archive",
  readiness: async () => ({ state: "ready" as const }),
  upload: jest.fn(async () => ({ remoteId: "remote", bytes: 42 })),
})

it("namespaces declarations, refuses collisions and undeclared contributions, and emits revisions", () => {
  const listener = jest.fn()
  const stop = subscribeBackupDestinations(listener)
  const revision = getBackupDestinationRevision()
  const input = contribution()
  expect(() => registerBackupDestination(input, { pluginId: "test", declarations: [] })).toThrow(
    /declared/
  )
  const owner = { pluginId: "test", declarations: [{ id: "archive", label: "Archive" }] }
  const dispose = registerBackupDestination(input, owner)
  expect(getBackupDestination("plugin:test/archive")?.label).toBe("Archive")
  expect(listBackupDestinations().some((row) => row.id === "plugin:test/archive")).toBe(true)
  expect(() => registerBackupDestination(input, owner)).toThrow(/registered/)
  expect(() =>
    registerBackupDestination(
      { ...input, id: "webdav" },
      { ...owner, declarations: [{ id: "webdav", label: "Archive" }] }
    )
  ).toThrow(/reserved/)
  expect(getBackupDestinationRevision()).toBe(revision + 1)
  dispose()
  dispose()
  expect(getBackupDestinationRevision()).toBe(revision + 2)
  expect(listener).toHaveBeenCalledTimes(2)
  stop()
})

it.each(["task", "dispose"])(
  "aborts an in-flight operation on %s and drops a late result",
  async (cause) => {
    const input = contribution()
    const dispose = registerBackupDestination(input, { pluginId: "cancel", declarations: [input] })
    const controller = new AbortController()
    let finish!: (value: string) => void
    let signal!: AbortSignal
    const result = withBackupDestination(
      "plugin:cancel/archive",
      controller.signal,
      async (_entry, active) => {
        signal = active
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      }
    )
    if (cause === "task") controller.abort()
    else dispose()
    expect(signal.aborted).toBe(true)
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    finish("late success")
    dispose()
  }
)

it("collects ciphertext streams and cancels their reader when aborted", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ciphertext"))
      controller.close()
    },
  })
  expect(new TextDecoder().decode(await readBackupDestinationBody(source))).toBe("ciphertext")
  const controller = new AbortController()
  const cancel = jest.fn()
  const waiting = readBackupDestinationBody(
    new ReadableStream<Uint8Array>({ cancel }),
    controller.signal
  )
  controller.abort()
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" })
  expect(cancel).toHaveBeenCalledTimes(1)
})
