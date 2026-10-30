import { PluginActivationConflictError, PluginLifecycleCoordinator } from "./lifecycle-coordinator"
import type { PluginIntent } from "./lifecycle-state"

describe("PluginLifecycleCoordinator", () => {
  function intentFixture() {
    const coordinator = new PluginLifecycleCoordinator()
    let intent: PluginIntent = "enabled"
    let active = true
    const operations = {
      snapshot: jest.fn(async () => ({ intent, resume: active, suspended: false })),
      pause: jest.fn(async () => {
        intent = "disabled"
        active = false
      }),
      restore: jest.fn(async (snapshot: { intent: PluginIntent; resume: boolean }) => {
        intent = snapshot.intent
        active = snapshot.resume
      }),
      commit: jest.fn(),
    }
    return {
      coordinator,
      operations,
      state: () => ({ intent, active }),
      manualStateOnly: async (next: PluginIntent) => {
        intent = next
      },
      manual: async (next: PluginIntent) => {
        await coordinator.withIntentTransition("manager", "p", async () => {
          intent = next
          active = next === "enabled"
          coordinator.invalidateIntentPause("p")
        })
      },
    }
  }

  it.each([false, true])(
    "restores only after the last overlapping pause (reverse: %s)",
    async (reverse) => {
      const t = intentFixture()
      const a = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
      const b = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
      const [first, last] = reverse ? [b, a] : [a, b]
      await first.restore()
      expect(t.state()).toEqual({ intent: "disabled", active: false })
      expect(t.operations.restore).not.toHaveBeenCalled()
      await last.restore()
      await last.restore()
      expect(t.state()).toEqual({ intent: "enabled", active: true })
      expect(t.operations.snapshot).toHaveBeenCalledTimes(1)
      expect(t.operations.pause).toHaveBeenCalledTimes(1)
      expect(t.operations.restore).toHaveBeenCalledTimes(1)
      expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual([])
    }
  )

  it("does not restore over a newer manual choice even when its value is still disabled", async () => {
    const t = intentFixture()
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    await t.manual("disabled")
    expect(lease.isCurrent()).toBe(false)
    await lease.restore()
    expect(t.operations.restore).not.toHaveBeenCalled()
    expect(t.state()).toEqual({ intent: "disabled", active: false })
  })

  it("does not publish a stale replacement after a newer enable", async () => {
    const t = intentFixture()
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    await t.manual("enabled")
    await lease.commit()
    expect(t.operations.commit).not.toHaveBeenCalled()
    expect(t.state()).toEqual({ intent: "enabled", active: true })
  })

  it("defers the pause and snapshots the runtime only when it is applied", async () => {
    const t = intentFixture()
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations, {
      deferred: true,
    })
    expect(t.operations.snapshot).not.toHaveBeenCalled()
    expect(t.operations.pause).not.toHaveBeenCalled()
    expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual(["p"])
    await lease.pause()
    expect(t.state()).toEqual({ intent: "disabled", active: false })
    await lease.restore()
    expect(t.state()).toEqual({ intent: "enabled", active: true })
  })

  it.each(["enabled", "disabled"] as const)(
    "invalidates a deferred replacement on newer %s intent",
    async (intent) => {
      const t = intentFixture()
      const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations, {
        deferred: true,
      })
      await t.manual(intent)
      await lease.pause()
      await lease.commit()
      expect(t.operations.pause).not.toHaveBeenCalled()
      expect(t.operations.commit).not.toHaveBeenCalled()
      expect(t.state()).toEqual({ intent, active: intent === "enabled" })
      expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual([])
    }
  )

  it("serializes publication before a queued manual decision", async () => {
    const t = intentFixture()
    const events: string[] = []
    let release!: () => void
    let started!: () => void
    const publishing = new Promise<void>((resolve) => {
      started = resolve
    })
    t.operations.commit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            events.push("replacement")
            resolve()
          }
          started()
        })
    )
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    const committed = lease.commit()
    await publishing
    const manual = t.manual("enabled").then(() => events.push("manual"))
    release()
    await Promise.all([committed, manual])
    expect(events).toEqual(["replacement", "manual"])
    expect(t.state()).toEqual({ intent: "enabled", active: true })
  })

  it("commits one owned replacement without letting a temporary holder resurrect it", async () => {
    const t = intentFixture()
    const temporary = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    const replacement = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    await replacement.commit()
    await temporary.restore()
    await replacement.commit()
    expect(t.operations.commit).toHaveBeenCalledTimes(1)
    expect(t.operations.restore).not.toHaveBeenCalled()
    expect(t.state()).toEqual({ intent: "disabled", active: false })
  })

  it("releases a snapshot failure without writing or retaining an owner", async () => {
    const t = intentFixture()
    t.operations.snapshot.mockRejectedValueOnce(new Error("snapshot failed"))
    await expect(t.coordinator.acquireIntentPause("manager", "p", t.operations)).rejects.toThrow(
      "snapshot failed"
    )
    expect(t.operations.pause).not.toHaveBeenCalled()
    expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual([])
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    await lease.restore()
    expect(t.state()).toEqual({ intent: "enabled", active: true })
  })

  it("reports restore failure, releases the lease, and still permits a newer user choice", async () => {
    const t = intentFixture()
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    t.operations.restore.mockRejectedValueOnce(new Error("restore failed"))
    await expect(lease.restore()).rejects.toThrow("restoreFailed")
    expect(lease.isCurrent()).toBe(false)
    expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual([])
    await t.manual("enabled")
    expect(t.state()).toEqual({ intent: "enabled", active: true })
  })

  it("compensates a failed commit and clears its lease", async () => {
    const t = intentFixture()
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    t.operations.commit.mockRejectedValueOnce(new Error("commit failed"))
    await expect(lease.commit()).rejects.toThrow("restoreFailed")
    expect(t.state()).toEqual({ intent: "enabled", active: true })
    expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual([])
  })

  it("rejects another manager's pause without disturbing the existing holder", async () => {
    const t = intentFixture()
    const lease = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    await expect(t.coordinator.acquireIntentPause("other", "p", t.operations)).rejects.toThrow(
      PluginActivationConflictError
    )
    expect(t.coordinator.getIntentOperationPluginIds("other")).toEqual([])
    expect(lease.isCurrent()).toBe(true)
    expect(t.operations.pause).toHaveBeenCalledTimes(1)
    await lease.restore()
    expect(t.state()).toEqual({ intent: "enabled", active: true })
  })

  it.each(["pause", "commit"] as const)(
    "propagates failed compensation to a shared holder's %s",
    async (action) => {
      const t = intentFixture()
      const shared = await t.coordinator.acquireIntentPause("manager", "p", t.operations, {
        deferred: true,
      })
      const pause = t.operations.pause.getMockImplementation()!
      t.operations.pause.mockImplementationOnce(async () => {
        await pause()
        throw new Error("teardown failed")
      })
      t.operations.restore.mockImplementationOnce(async (snapshot) => {
        // The real manager restores durable intent before retrying activation.
        await t.manualStateOnly(snapshot.intent)
        throw new Error("reactivation failed")
      })
      await expect(t.coordinator.acquireIntentPause("manager", "p", t.operations)).rejects.toThrow(
        "restoreFailed"
      )
      await expect(shared[action]()).rejects.toThrow("restoreFailed")
      expect(t.operations.commit).not.toHaveBeenCalled()
      await shared.restore()
      expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual([])
      expect(t.state()).toEqual({ intent: "enabled", active: true })
    }
  )

  it("compensates a failed pause before releasing its transition owner", async () => {
    const t = intentFixture()
    const pause = t.operations.pause.getMockImplementation()!
    t.operations.pause.mockImplementationOnce(async () => {
      await pause()
      throw new Error("late pause failure")
    })
    await expect(t.coordinator.acquireIntentPause("manager", "p", t.operations)).rejects.toThrow(
      "late pause failure"
    )
    expect(t.state()).toEqual({ intent: "enabled", active: true })
    expect(t.coordinator.getIntentOperationPluginIds("manager")).toEqual([])
    const next = await t.coordinator.acquireIntentPause("manager", "p", t.operations)
    await next.restore()
    expect(t.state()).toEqual({ intent: "enabled", active: true })
  })
  it("allows only one manager generation to own a plugin at a time", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.acquire("manager-a", "example")

    expect(() => coordinator.acquire("manager-b", "example")).toThrow(PluginActivationConflictError)
    expect(coordinator.isCurrent(first)).toBe(true)

    coordinator.release(first)
    const second = coordinator.acquire("manager-b", "example")
    expect(second.generation).toBeGreaterThan(first.generation)
  })

  it("does not let an old generation release the current owner", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.acquire("manager-a", "example")
    coordinator.release(first)
    const second = coordinator.acquire("manager-a", "example")

    coordinator.release(first)

    expect(coordinator.isCurrent(second)).toBe(true)
  })

  it("blocks dependent admission while a provider is draining", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const reservation = coordinator.reserveProviderDrain("manager-a", "provider")

    expect(() => coordinator.assertProvidersAccepting(["provider"])).toThrow(
      "Plugin dependency provider is draining"
    )
    coordinator.releaseProviderDrain(reservation)
    expect(() => coordinator.assertProvidersAccepting(["provider"])).not.toThrow()
  })

  it("does not let a stale graph reservation release a newer one", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.reserveProviderDrain("manager-a", "provider")
    coordinator.releaseProviderDrain(first)
    const second = coordinator.reserveProviderDrain("manager-a", "provider")

    expect(coordinator.releaseProviderDrain(first)).toBe(false)
    expect(coordinator.isProviderDraining("provider")).toBe(true)
    expect(coordinator.releaseProviderDrain(second)).toBe(true)
  })

  it("publishes redacted lifecycle snapshots to subscribers", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const seen: string[][] = []
    coordinator.subscribe((snapshot) => seen.push(snapshot.map((entry) => entry.pluginId)))
    const lease = coordinator.acquire("manager-a", "example")

    expect(
      coordinator.updateSnapshot({
        managerId: "manager-a",
        pluginId: "example",
        generation: lease.generation,
        intent: "enabled",
        actual: "active",
        stateSince: 123,
        requiredServices: ["workspace.backend"],
        providedServices: [],
        currentProviders: ["workspace.backend:workspace"],
        effects: { active: 2, pending: 0, failed: 0, labels: ["ctx.events.on"] },
        dirty: {
          runtime: "node",
          reason: "error",
          at: 123,
          message: "x".repeat(1_000),
          runtimeGeneration: "g".repeat(200),
          labels: Array.from({ length: 30 }, (_, index) => `effect-${index}`),
        },
      })
    ).toBe(true)

    expect(coordinator.getSnapshot("example")).toMatchObject({
      actual: "active",
      generation: lease.generation,
      effects: { active: 2 },
      dirty: {
        message: "x".repeat(512),
        runtimeGeneration: "g".repeat(128),
        labels: expect.arrayContaining(["effect-0"]),
      },
    })
    expect(coordinator.getSnapshot("example")?.dirty?.labels).toHaveLength(20)
    expect(seen.at(-1)).toEqual(["example"])
  })

  it("rejects a stale generation snapshot update", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.acquire("manager-a", "example")
    coordinator.release(first)
    const second = coordinator.acquire("manager-a", "example")

    expect(
      coordinator.updateSnapshot({
        managerId: "manager-a",
        pluginId: "example",
        generation: first.generation,
        intent: "enabled",
        actual: "error",
        stateSince: 1,
        requiredServices: [],
        providedServices: [],
        currentProviders: [],
        effects: { active: 0, pending: 0, failed: 0, labels: [] },
      })
    ).toBe(false)
    expect(coordinator.get("example")).toEqual(second)
  })
})
