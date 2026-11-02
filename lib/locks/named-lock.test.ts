import "fake-indexeddb/auto"
import { NamedLockError, NamedLockUnavailable, withNamedLock } from "./named-lock"

it("uses navigator locks and invalidates retained guards", async () => {
  const request = jest.fn(async (_name, run) => run())
  let guard!: () => void
  await expect(
    withNamedLock(
      "test",
      async (held) => {
        guard = held
        return 7
      },
      { locks: { request } }
    )
  ).resolves.toBe(7)
  expect(request).toHaveBeenCalledWith("test", expect.any(Function))
  expect(guard).toThrow(NamedLockError)
})

it.each(["indexeddb", "in-process"] as const)(
  "serializes %s holders and releases after failure",
  async (mode) => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const options = { mode, locks: null, databaseName: "named-lock-custom", storeName: "custom" }
    const order: string[] = []
    let guard!: () => void
    const first = withNamedLock(
      "shared",
      async (held) => {
        guard = held
        enter()
        await released
        held()
        order.push("first")
      },
      options
    )
    await entered
    const second = withNamedLock(
      "shared",
      async () => {
        order.push("second")
      },
      options
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(order).toEqual([])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(["first", "second"])
    expect(guard).toThrow("no longer held")
    await expect(
      withNamedLock(
        "shared",
        async () => {
          throw new Error("failure")
        },
        options
      )
    ).rejects.toThrow("failure")
    await expect(withNamedLock("shared", async () => 1, options)).resolves.toBe(1)
  }
)

it("observes IndexedDB contention across independent module instances", async () => {
  let other!: typeof withNamedLock
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    other = require("./named-lock").withNamedLock
  })
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const options = { mode: "indexeddb" as const, databaseName: "separate-realms" }
  const first = withNamedLock(
    "shared",
    async () => {
      entered()
      await gate
    },
    options
  )
  await started
  const task = jest.fn(async () => "second")
  try {
    await expect(other("shared", task, { ...options, ifAvailable: true })).rejects.toMatchObject({
      name: "NamedLockUnavailable",
    })
    expect(task).not.toHaveBeenCalled()
  } finally {
    release()
    await first
  }
  await expect(other("shared", task, options)).resolves.toBe("second")
})

it("recovers an abandoned IndexedDB reservation through the transaction domain", async () => {
  const request = indexedDB.open("abandoned:shared:availability", 1)
  request.onupgradeneeded = () => request.result.createObjectStore("holders")
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction("holders", "readwrite")
      tx.objectStore("holders").put("crashed-owner", "locks")
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
  await expect(
    withNamedLock("shared", async () => "recovered", {
      mode: "indexeddb",
      databaseName: "abandoned",
    })
  ).resolves.toBe("recovered")
})

it("requires explicit permission to use a process mutex without browser primitives", async () => {
  const original = globalThis.indexedDB
  Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true })
  try {
    await expect(withNamedLock("headless", async () => 1, { locks: null })).rejects.toThrow(
      "unavailable"
    )
    await expect(
      withNamedLock("headless", async () => 1, { locks: null, allowInProcess: true })
    ).resolves.toBe(1)
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { value: original, configurable: true })
  }
})

it("does not block another IndexedDB lock name behind a held lineage", async () => {
  let release!: () => void
  let enter!: () => void
  const started = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const options = { mode: "indexeddb" as const, databaseName: "independent-lineages", waitMs: 20 }
  const first = withNamedLock(
    "lineage-a",
    async () => {
      enter()
      await gate
    },
    options
  )
  await started
  try {
    await expect(withNamedLock("lineage-b", async () => "independent", options)).resolves.toBe(
      "independent"
    )
  } finally {
    release()
    await first
  }
})

it("uses the Web Locks try-lock option and never invokes work for a null lock", async () => {
  const task = jest.fn(async () => 1)
  const request = jest.fn(async (_name, _options, run) => run(null))
  await expect(
    withNamedLock("held", task, { ifAvailable: true, locks: { request } as never })
  ).rejects.toBeInstanceOf(NamedLockUnavailable)
  expect(request).toHaveBeenCalledWith("held", { ifAvailable: true }, expect.any(Function))
  expect(task).not.toHaveBeenCalled()
  request.mockImplementation(async (_name, _options, run) => run({ name: "held" }))
  await expect(
    withNamedLock("held", task, { ifAvailable: true, locks: { request } as never })
  ).resolves.toBe(1)
})

it("does not mistake delayed IndexedDB work on an idle lock for contention", async () => {
  const get = IDBObjectStore.prototype.get
  let delayed = false
  const delayedGet = (store: IDBObjectStore, key: IDBValidKey | IDBKeyRange) => {
    const request = get.call(store, key)
    if (delayed || store.name !== "locks") return request
    delayed = true
    return new Proxy(request, {
      set(target, property, value) {
        if (property !== "onsuccess") return Reflect.set(target, property, value)
        target.onsuccess = (event) => {
          const until = Date.now() + 30
          const pump = () => {
            const pending = get.call(store, key)
            pending.onsuccess = () => {
              if (Date.now() < until) pump()
              else value.call(target, event)
            }
          }
          pump()
        }
        return true
      },
    })
  }
  const spy = jest.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
    this: IDBObjectStore,
    key
  ) {
    return delayedGet(this, key)
  })
  const task = jest.fn(async () => "acquired")
  try {
    await expect(
      withNamedLock("slow-idle", task, {
        mode: "indexeddb",
        ifAvailable: true,
        databaseName: "delayed-idb",
      })
    ).resolves.toBe("acquired")
    expect(task).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
})

it.each(["indexeddb", "in-process"] as const)(
  "tries %s without waiting behind a holder and succeeds after release",
  async (mode) => {
    let enter!: () => void
    let release!: () => void
    const started = new Promise<void>((r) => {
      enter = r
    })
    const gate = new Promise<void>((r) => {
      release = r
    })
    const options = { mode, databaseName: `try-lock-${mode}` }
    const first = withNamedLock(
      "held",
      async () => {
        enter()
        await gate
      },
      options
    )
    await started
    const task = jest.fn(async () => 7)
    try {
      await expect(
        withNamedLock("held", task, { ...options, ifAvailable: true })
      ).rejects.toBeInstanceOf(NamedLockUnavailable)
      expect(task).not.toHaveBeenCalled()
    } finally {
      release()
      await first
    }
    await expect(withNamedLock("held", task, { ...options, ifAvailable: true })).resolves.toBe(7)
  }
)
