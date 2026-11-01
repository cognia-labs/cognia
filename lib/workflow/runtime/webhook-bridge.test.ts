/**
 * @jest-environment jsdom
 */
import {
  getWorkflowTriggerHealth,
  resetWorkflowTriggerHealthForTest,
} from "./trigger-registration-health"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

// Mock the tauri-bridge module at hoist time so the bridge under test
// dispatches into our spies instead of the real `safeInvoke` path.
const mockRegister = jest.fn().mockResolvedValue(undefined)
const mockUnregister = jest.fn().mockResolvedValue(undefined)
const mockGetUrl = jest.fn().mockResolvedValue("http://127.0.0.1:9999/webhook/x")
const mockPluginSync = jest.fn().mockResolvedValue(undefined)
const mockPluginUnsync = jest.fn().mockResolvedValue(undefined)

jest.mock("./tauri-bridge", () => ({
  registerTrigger: (...args: unknown[]) => mockRegister(...args),
  unregisterTrigger: (...args: unknown[]) => mockUnregister(...args),
  getWebhookUrl: (...args: unknown[]) => mockGetUrl(...args),
}))
jest.mock("@/lib/workflow/triggers/lifecycle", () => ({
  syncPluginTriggerInstances: (...args: unknown[]) => mockPluginSync(...args),
  unsyncPluginTriggerInstances: (...args: unknown[]) => mockPluginUnsync(...args),
}))

// IMPORTANT: import after the mock is declared.

import {
  _resetSyncedTriggerStateForTest,
  syncWorkflowTriggers,
  unsyncWorkflowTriggers,
  getWebhookUrl,
} from "./webhook-bridge"

beforeEach(() => {
  resetWorkflowTriggerHealthForTest()
  _resetSyncedTriggerStateForTest()
  mockRegister.mockClear()
  mockUnregister.mockClear()
  mockGetUrl.mockClear()
  mockPluginSync.mockClear()
  mockPluginUnsync.mockClear()
})

function node(
  id: string,
  type: WorkflowNode["type"],
  params: Record<string, unknown> = {},
  disabled = false
): WorkflowNode {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params, disabled },
  }
}

function workflow(nodes: WorkflowNode[]): VisualWorkflow {
  return {
    id: "wf_a",
    schemaVersion: 1,
    name: "wf",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 0,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

describe("sync and unsync of one workflow are serialized", () => {
  // Convergence 0b B2 review: an unsync that ran while a registration was in
  // flight dropped the projection, and the late registration was then never
  // unregistered by a later sync.
  it("unregisters a registration that completed after a concurrent unsync", async () => {
    let finishRegistration: () => void = () => undefined
    mockRegister.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRegistration = resolve
        })
    )
    const wf = workflow([node("t_manual", "trigger.manual")])
    const syncing = syncWorkflowTriggers(wf)
    const unsyncing = unsyncWorkflowTriggers(workflow([]))
    const resyncing = syncWorkflowTriggers(workflow([]))
    while (mockRegister.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    finishRegistration()
    await Promise.all([syncing, unsyncing, resyncing])

    // The unsync ran after the registration finished, so it saw and removed it.
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "t_manual")
  })
})

describe("syncWorkflowTriggers", () => {
  it("registers nothing when the workflow has no trigger nodes", async () => {
    const wf = workflow([node("a", "ai.prompt")])
    await syncWorkflowTriggers(wf)
    expect(mockRegister).not.toHaveBeenCalled()
    expect(mockPluginSync).toHaveBeenCalledWith(wf)
  })

  it("registers a trigger.cron with the cron expression", async () => {
    await syncWorkflowTriggers(
      workflow([node("trg", "trigger.cron", { cron: "*/5 * * * *", timezone: "UTC" })])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0]).toMatchObject({
      workflowId: "wf_a",
      triggerId: "trg",
      kind: "trigger.cron",
      enabled: true,
      cron: "*/5 * * * *",
      timezone: "UTC",
    })
  })

  it("registers a trigger.webhook with method / hmacSecret / response shape", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("trg", "trigger.webhook", {
          path: "incoming",
          method: "POST",
          hmacSecret: "shh",
          responseStatus: 202,
          responseTemplate: "ok",
        }),
      ])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0]).toMatchObject({
      triggerId: "trg",
      kind: "trigger.webhook",
      webhookPath: "incoming",
      webhookMethod: "POST",
      webhookHmacSecret: "shh",
      webhookResponseStatus: 202,
      webhookResponseBody: "ok",
      // No io.webhook.respond node → the receiver replies synchronously.
      webhookAwaitResponse: false,
    })
  })

  it("passes the delivery id header, and none when it is blank", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("trg", "trigger.webhook", {
          path: "incoming",
          deliveryIdHeader: " X-GitHub-Delivery ",
        }),
        node("blank", "trigger.webhook", { path: "other", deliveryIdHeader: "  " }),
      ])
    )
    const calls = mockRegister.mock.calls.map(([input]) => input)
    expect(calls.find((c) => c.triggerId === "trg")).toMatchObject({
      webhookDeliveryIdHeader: "X-GitHub-Delivery",
    })
    expect(calls.find((c) => c.triggerId === "blank")?.webhookDeliveryIdHeader).toBeUndefined()
  })

  it("sets webhookAwaitResponse when the workflow has an io.webhook.respond node", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("trg", "trigger.webhook", { path: "incoming", responseTimeoutMs: 8000 }),
        node("resp", "io.webhook.respond", { status: 200 }),
      ])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0]).toMatchObject({
      kind: "trigger.webhook",
      webhookAwaitResponse: true,
      webhookResponseTimeoutMs: 8000,
    })
  })

  it("does not register disabled triggers", async () => {
    await syncWorkflowTriggers(
      workflow([node("trg", "trigger.cron", { cron: "* * * * *" }, /*disabled*/ true)])
    )
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("does not register template or built-in gallery workflows", async () => {
    const template = { ...workflow([node("a", "trigger.manual")]), isTemplate: true }
    const builtIn = { ...workflow([node("b", "trigger.manual")]), isBuiltIn: true }

    await syncWorkflowTriggers(template)
    await syncWorkflowTriggers(builtIn)

    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("unregisters a trigger removed since the previous sync", async () => {
    await syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "* * * * *" })]))
    mockRegister.mockClear()

    await syncWorkflowTriggers(workflow([]))

    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "trg")
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("unregisters before re-registering a trigger whose kind changed", async () => {
    await syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "* * * * *" })]))
    mockRegister.mockClear()
    mockUnregister.mockClear()

    await syncWorkflowTriggers(workflow([node("trg", "trigger.webhook", { path: "incoming" })]))

    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "trg")
    expect(mockUnregister.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegister.mock.invocationCallOrder[0]
    )
  })

  it("removes the previous live projection when an edited cron becomes invalid", async () => {
    await syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "* * * * *" })]))
    mockRegister.mockClear()
    mockUnregister.mockClear()

    await expect(
      syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "invalid" })]))
    ).rejects.toThrow(/Cannot register workflow cron/)

    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "trg")
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("registers TS-hook triggers with the base envelope only", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("a", "trigger.manual"),
        node("b", "trigger.chat.message"),
        node("c", "trigger.connector.inbound"),
        node("d", "trigger.goal.completed"),
        node("e", "trigger.terminal.command"),
        node("f", "trigger.desktop.event"),
        node("g", "trigger.team"),
      ])
    )
    expect(mockRegister).toHaveBeenCalledTimes(7)
    expect(mockRegister.mock.calls.map((call) => call[0].kind)).toEqual([
      "trigger.manual",
      "trigger.chat.message",
      "trigger.connector.inbound",
      "trigger.goal.completed",
      "trigger.terminal.command",
      "trigger.desktop.event",
      "trigger.team",
    ])
    for (const call of mockRegister.mock.calls) {
      expect(call[0]).not.toHaveProperty("cron")
      expect(call[0]).not.toHaveProperty("webhookPath")
    }
  })

  it("skips unknown trigger.* kinds without throwing (forward-compat)", async () => {
    await syncWorkflowTriggers(
      workflow([
        // A new trigger kind a future plugin might register; the bridge
        // shouldn't crash the canvas save path.
        node("trg", "trigger.future" as WorkflowNode["type"]),
      ])
    )
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("dispatches all triggers in parallel", async () => {
    const order: string[] = []
    mockRegister.mockImplementationOnce(async (input: { triggerId: string }) => {
      order.push(`${input.triggerId}-end`)
    })
    mockRegister.mockImplementationOnce(async (input: { triggerId: string }) => {
      order.push(`${input.triggerId}-end`)
    })
    await syncWorkflowTriggers(
      workflow([
        node("a", "trigger.cron", { cron: "* * * * *" }),
        node("b", "trigger.cron", { cron: "* * * * *" }),
      ])
    )
    expect(order).toEqual(["a-end", "b-end"])
  })

  it("does not start plugin sources when startup sync is aborted during native registration", async () => {
    let resolveRegister!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    mockRegister.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRegister = resolve
          markStarted()
        })
    )
    const controller = new AbortController()
    const pending = syncWorkflowTriggers(workflow([node("a", "trigger.manual")]), {
      signal: controller.signal,
    })
    await started

    controller.abort()
    resolveRegister()
    await pending

    expect(mockPluginSync).not.toHaveBeenCalled()
  })
})

describe("trigger.file.watch", () => {
  it("registers the authored watch config, not a bare no-op", async () => {
    // The only Rust-backed trigger of the five added alongside it, so unlike
    // its siblings its params actually have to reach the daemon.
    await syncWorkflowTriggers(
      workflow([
        node("t1", "trigger.file.watch", {
          root: "/Users/me/project",
          globs: ["src/**/*.ts"],
          ignoreGlobs: ["**/*.test.ts"],
          events: ["created", "modified"],
          respectGitignore: false,
          recursive: true,
          debounceMs: 400,
          settleMs: 3000,
          catchUpOnStart: true,
          maxFiresPerMinute: 12,
        }),
      ])
    )
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "trigger.file.watch",
        fileWatchRoot: "/Users/me/project",
        fileWatchGlobs: ["src/**/*.ts"],
        fileWatchIgnoreGlobs: ["**/*.test.ts"],
        fileWatchEvents: ["created", "modified"],
        fileWatchRespectGitignore: false,
        fileWatchRecursive: true,
        fileWatchDebounceMs: 400,
        fileWatchSettleMs: 3000,
        fileWatchCatchUpOnStart: true,
        fileWatchMaxFiresPerMinute: 12,
      })
    )
  })

  it("refuses a relative or empty root where the author can see it", async () => {
    // Rust refuses these too and stays the authority. Failing here means the
    // author finds out at save time rather than from a daemon nobody watches.
    await expect(
      syncWorkflowTriggers(workflow([node("t1", "trigger.file.watch", { root: "relative/dir" })]))
    ).rejects.toThrow(/absolute path/)
    await expect(
      syncWorkflowTriggers(workflow([node("t1", "trigger.file.watch", { root: "  " })]))
    ).rejects.toThrow(/no root directory/)
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("accepts a Windows root", async () => {
    await syncWorkflowTriggers(
      workflow([node("t1", "trigger.file.watch", { root: "C:\\Users\\me\\project" })])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })

  it("does not watch this disk for a workflow pinned to another Host", async () => {
    // A pinned run happens elsewhere, so a watch registered here would fire on
    // this machine's churn for a run that never touches it. The pinned Host
    // installs its own from its own boot sync.
    const wf = workflow([node("t1", "trigger.file.watch", { root: "/Users/me/project" })])
    await syncWorkflowTriggers({
      ...wf,
      settings: { ...wf.settings, runOn: { mode: "pinned", ref: "host_other" } },
    })
    expect(mockRegister).not.toHaveBeenCalled()
    expect(getWorkflowTriggerHealth().registrations).toContainEqual(
      expect.objectContaining({ workflowId: wf.id, triggerId: "t1", status: "skipped" })
    )
  })

  it("still watches for colocate and auto, which both mean wherever this runs", async () => {
    const wf = workflow([node("t1", "trigger.file.watch", { root: "/Users/me/project" })])
    await syncWorkflowTriggers({
      ...wf,
      settings: { ...wf.settings, runOn: { mode: "auto" } },
    })
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })

  it("unregisters a watch whose node was deleted", async () => {
    const wf = workflow([node("t1", "trigger.file.watch", { root: "/Users/me/project" })])
    await syncWorkflowTriggers(wf)
    mockUnregister.mockClear()
    await syncWorkflowTriggers({ ...wf, nodes: [] })
    expect(mockUnregister).toHaveBeenCalledWith(wf.id, "t1")
  })
})

describe("unsyncWorkflowTriggers", () => {
  it("unregisters every trigger node by id", async () => {
    const wf = workflow([
      node("trg_1", "trigger.cron", { cron: "* * * * *" }),
      node("a", "ai.prompt"),
      node("trg_2", "trigger.webhook", { path: "x" }),
    ])
    await unsyncWorkflowTriggers(wf)
    expect(mockUnregister).toHaveBeenCalledTimes(2)
    expect(mockUnregister.mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining(["trg_1", "trg_2"])
    )
    expect(mockPluginUnsync).toHaveBeenCalledWith(wf)
  })

  it("is a no-op when the workflow has no triggers", async () => {
    await unsyncWorkflowTriggers(workflow([node("a", "ai.prompt")]))
    expect(mockUnregister).not.toHaveBeenCalled()
  })
})

describe("getWebhookUrl re-export", () => {
  it("forwards to the tauri-bridge implementation", async () => {
    const url = await getWebhookUrl("wf_a", "trg")
    expect(mockGetUrl).toHaveBeenCalledWith("wf_a", "trg")
    expect(url).toBe("http://127.0.0.1:9999/webhook/x")
  })
})

it("records all trigger outcomes even when one native registration fails", async () => {
  mockRegister.mockImplementation(async (input) => {
    if (input.triggerId === "bad") throw new Error("host rejected")
  })
  try {
    await expect(
      syncWorkflowTriggers(
        workflow([
          node("bad", "trigger.cron", { cron: "@daily" }),
          node("good", "trigger.cron", { cron: "@hourly" }),
        ])
      )
    ).rejects.toThrow("host rejected")
    expect(getWorkflowTriggerHealth().registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ triggerId: "bad", status: "failed", error: "host rejected" }),
        expect.objectContaining({ triggerId: "good", status: "registered" }),
      ])
    )
  } finally {
    mockRegister.mockReset().mockResolvedValue(undefined)
  }
})

it("records validation rejection and unregisters the invalid persisted schedule", async () => {
  await expect(
    syncWorkflowTriggers(workflow([node("bad", "trigger.cron", { cron: "0 0 L * *" })]))
  ).rejects.toThrow()
  expect(getWorkflowTriggerHealth().registrations).toContainEqual(
    expect.objectContaining({ triggerId: "bad", status: "failed" })
  )
  expect(mockUnregister).toHaveBeenCalledWith("wf_a", "bad")
})

it("removes a successfully registered sibling after a partial sync failure", async () => {
  mockRegister.mockImplementation(async (input) => {
    if (input.triggerId === "bad") throw new Error("rejected")
  })
  try {
    await expect(
      syncWorkflowTriggers(
        workflow([node("good", "trigger.manual"), node("bad", "trigger.manual")])
      )
    ).rejects.toThrow("rejected")
    mockRegister.mockResolvedValue(undefined)
    await syncWorkflowTriggers(workflow([node("bad", "trigger.manual")]))
    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "good")
  } finally {
    mockRegister.mockReset().mockResolvedValue(undefined)
  }
})
