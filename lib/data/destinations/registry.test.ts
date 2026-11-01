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

it.each([
  { executionRunId: "backup-service-attempt" },
  { localAuthorization: LOCAL_PERSON_RUN },
] as const)(
  "preserves exact backup operation identity through nested wrappers: %p",
  async (context) => {
    const seen: unknown[] = []
    const input = {
      ...contribution(),
      readiness: async () => {
        await Promise.resolve()
        seen.push(pluginExecutionContext("backup-operation"))
        return { state: "ready" as const }
      },
      upload: async () => {
        await Promise.resolve()
        seen.push(pluginExecutionContext("backup-operation"))
        return { remoteId: "safe", bytes: 1 }
      },
      list: async (...args: unknown[]) => {
        await Promise.resolve()
        expect(args).toHaveLength(1)
        seen.push(pluginExecutionContext("backup-operation"))
        return []
      },
      download: async (...args: unknown[]) => {
        await Promise.resolve()
        expect(args).toHaveLength(2)
        seen.push(pluginExecutionContext("backup-operation"))
        return new Uint8Array()
      },
    }
    const dispose = registerBackupDestination(input, {
      pluginId: "backup-operation",
      declarations: [input],
    })
    try {
      await withBackupDestination(
        "plugin:backup-operation/archive",
        undefined,
        async (entry, signal) => {
          await entry.readiness(signal)
          await entry.upload({} as never, signal)
          await entry.list!(signal, context)
          await entry.download!("one", signal, context)
        },
        context
      )
      expect(seen).toEqual([context, context, context, context])
      expect(pluginExecutionContext("backup-operation")).toBeUndefined()
    } finally {
      dispose()
    }
  }
)

it("keeps backup identity inside Host wrappers and retains cancelled callbacks to settlement", async () => {
  const input = contribution()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  input.upload = jest.fn(async () => {
    await waiting
    expect(pluginExecutionContext("bound-backup")).toEqual(HOST_BACKGROUND)
    return { remoteId: "safe", bytes: 1 }
  })
  const dispose = registerBackupDestination(input, {
    pluginId: "bound-backup",
    declarations: [input],
  })
  const entry = getBackupDestination("plugin:bound-backup/archive")!
  const controller = new AbortController()
  const pending = withBackupDestination(entry.id, controller.signal, (destination, signal) =>
    destination.upload({} as never, signal)
  )
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(pluginExecutionContext("bound-backup")).toEqual(HOST_BACKGROUND)
  release()
  await waiting
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await entry.readiness(new AbortController().signal, { localAuthorization: LOCAL_PERSON_RUN })
  expect(input.upload.mock.calls[0]).toHaveLength(2)
  dispose()
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
import { HOST_BACKGROUND, pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
