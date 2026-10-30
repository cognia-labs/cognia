import { test as base, expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { BotHost, until, remains } from "./host.mjs"

const test = base.extend({
  host: async ({}, provide, testInfo) => {
    const host = new BotHost()
    try {
      await host.open()
      await provide(host)
    } finally {
      try {
        await host.close()
      } finally {
        await testInfo.attach("bot-host-evidence", {
          body: JSON.stringify(host.evidence(), null, 2),
          contentType: "application/json",
        })
      }
    }
  },
})

test("@critical real plugin installation and manual delivery execute through Host and SQLite", async ({
  host,
}) => {
  const operationId = randomUUID()
  const installed = await host.install({ operationId })
  expect(installed.id).toBe(`boti_${operationId}`)
  expect((await host.install({ operationId })).id).toBe(installed.id)
  const key = randomUUID()
  const first = await host.run(installed.id, {}, "first", key)
  const second = await host.run(installed.id, {}, "first", key)
  expect(second.deliveryId).toBe(first.deliveryId)
  expect(second.created).toBe(false)
  const detail = await host.settled(first.runId)
  expect(detail.botResult.output.triggerId).toBe("first")
  expect(
    host.effects.filter((effect) => effect.runId === first.runId).map((effect) => effect.stage)
  ).toEqual(["first", "last"])
})

test("@critical one event identity remains independent across two manual triggers", async ({
  host,
}) => {
  const installed = await host.install()
  const key = randomUUID()
  const first = await host.run(installed.id, {}, "first", key)
  const second = await host.run(installed.id, {}, "second", key)
  expect(second.deliveryId).not.toBe(first.deliveryId)
  await host.settled(first.runId)
  await host.settled(second.runId)
  expect((await host.run(installed.id, {}, "second", key)).deliveryId).toBe(second.deliveryId)
  expect((await host.deliveries(installed.id)).map((row) => row.triggerId).sort()).toEqual([
    "first",
    "second",
  ])
  expect(host.effects).toHaveLength(4)
})

test("@critical event fanout delivers each matching trigger once under source redelivery", async ({
  host,
}) => {
  const producer = await host.install()
  const consumer = await host.install()
  const emitted = await host.run(producer.id, { emit: randomUUID(), emitCopies: 2 })
  await host.settled(emitted.runId)
  const deliveries = await until(
    () => host.deliveries(consumer.id),
    (rows) => rows.length === 2 && rows.every((row) => row.status === "succeeded"),
    "two event triggers"
  )
  expect(deliveries.map((row) => row.triggerId).sort()).toEqual(["event-a", "event-b"])
  expect(new Set(deliveries.map((row) => row.eventId)).size).toBe(1)
  expect(new Set(deliveries.map((row) => row.runId)).size).toBe(2)
  expect(
    host.effects.filter((effect) => deliveries.some((row) => row.runId === effect.runId))
  ).toHaveLength(4)
  expect(await host.deliveries(producer.id)).toHaveLength(1)
})

async function accountsFor(host) {
  const producer = await host.install()
  const setup = await host.run(producer.id, { setupAccounts: true })
  const detail = await host.settled(setup.runId)
  const accounts = Object.fromEntries(
    detail.botResult.output.accounts.map((account) => [account.name, account.id])
  )
  return { producer, accounts }
}

async function publish(host, producer, accountId, payload = {}, deliveryId = randomUUID()) {
  const result = await host.run(producer.id, { publish: { accountId, deliveryId, payload } })
  await host.settled(result.runId)
  return deliveryId
}

test("@critical input account selection isolates A/B and survives an input-slot change", async ({
  host,
}) => {
  const { producer, accounts } = await accountsFor(host)
  const consumer = await host.install({
    definitionId: "bot-e2e:bound",
    credentialBindings: {
      a: { integrationAccountId: accounts.a },
      b: { integrationAccountId: accounts.b },
    },
  })
  await publish(host, producer, accounts.b)
  expect(await host.deliveries(consumer.id)).toHaveLength(0)
  await publish(host, producer, accounts.a)
  await until(
    () => host.deliveries(consumer.id),
    (rows) => rows.length === 1 && rows[0].status === "succeeded",
    "A account delivery"
  )
  await host.mutate({
    operation: "input_slot",
    installationId: consumer.id,
    triggerId: "input",
    slotId: "b",
  })
  await publish(host, producer, accounts.a)
  expect(await host.deliveries(consumer.id)).toHaveLength(1)
  await publish(host, producer, accounts.b)
  await until(
    () => host.deliveries(consumer.id),
    (rows) => rows.length === 2 && rows.every((row) => row.status === "succeeded"),
    "B account delivery"
  )
  expect(
    host.effects.filter((effect) => effect.triggerId === "input").map((effect) => effect.accountId)
  ).toEqual([accounts.a, accounts.a, accounts.b, accounts.b])
  await expect(
    host.mutate({
      operation: "bind",
      installationId: consumer.id,
      slotId: "a",
      binding: { integrationAccountId: "foreign-missing-account" },
    })
  ).rejects.toThrow(/account does not match/)
})

test("@critical rebinding cancels accepted work and cannot execute it with the new account", async ({
  host,
}) => {
  const { producer, accounts } = await accountsFor(host)
  const consumer = await host.install({
    definitionId: "bot-e2e:bound",
    credentialBindings: {
      a: { integrationAccountId: accounts.a },
      b: { integrationAccountId: accounts.b },
    },
  })
  await publish(host, producer, accounts.a, { barrier: true })
  const [delivery] = await until(
    () => host.deliveries(consumer.id),
    (rows) => rows.length === 1 && Boolean(rows[0].runId),
    "bound running delivery"
  )
  await until(() => host.barriers.has(delivery.runId), Boolean, "bound workload barrier")
  await publish(host, producer, accounts.a)
  const old = await host.deliveries(consumer.id)
  const queued = old.find((row) => row.id !== delivery.id)
  expect(old).toHaveLength(2)
  expect(queued.status).toBe("pending")
  expect(queued.attempts).toBe(0)
  await host.mutate({
    operation: "bind",
    installationId: consumer.id,
    slotId: "a",
    binding: { integrationAccountId: accounts.b },
  })
  await host.settled(delivery.runId, "cancelled")
  await until(
    () => host.barriers.get(delivery.runId)?.size,
    (size) => size === 0,
    "rebind abort"
  )
  await host.restart()
  const cancelled = await host.deliveries(consumer.id)
  expect(cancelled).toHaveLength(2)
  expect(cancelled.every((row) => row.status === "dismissed" && row.cancelledAt > 0)).toBe(true)
  expect(host.effects.filter((effect) => effect.runId === `run_bot_${queued.id}`)).toHaveLength(0)
  await publish(host, producer, accounts.a)
  expect(await host.deliveries(consumer.id)).toHaveLength(2)
  await publish(host, producer, accounts.b)
  await until(
    () => host.deliveries(consumer.id),
    (rows) => rows.length === 3 && rows.some((row) => row.status === "succeeded"),
    "new account delivery"
  )
  expect(
    host.effects.filter((effect) => effect.runId === delivery.runId).map((effect) => effect.stage)
  ).toEqual(["first"])
})

test("@critical pause retains accepted work across SIGKILL and resume drains it once", async ({
  host,
}) => {
  const installed = await host.install()
  const active = await host.run(installed.id, { barrier: true })
  await until(() => host.barriers.has(active.runId), Boolean, "active workload barrier")
  const queued = await host.run(installed.id)
  await host.mutate({ operation: "automation", installationId: installed.id, action: "pause" })
  host.release(active.runId)
  await host.settled(active.runId)
  await host.restart()
  const pending = (await host.deliveries(installed.id)).find((row) => row.id === queued.deliveryId)
  expect(pending.status).toBe("pending")
  expect(pending.attempts).toBe(0)
  expect(host.effects.filter((effect) => effect.runId === queued.runId)).toHaveLength(0)
  await host.mutate({ operation: "automation", installationId: installed.id, action: "resume" })
  await host.settled(queued.runId)
  expect(host.effects.filter((effect) => effect.runId === queued.runId)).toHaveLength(2)
})

test("@critical cancellation aborts an executing handler and fences late effects after restart", async ({
  host,
}) => {
  const installed = await host.install()
  const active = await host.run(installed.id, { barrier: true })
  await until(() => host.barriers.has(active.runId), Boolean, "active workload barrier")
  await host.mutate({
    operation: "automation",
    installationId: installed.id,
    action: "cancel",
    deliveryId: active.deliveryId,
  })
  await host.settled(active.runId, "cancelled")
  await until(
    () => host.barriers.get(active.runId)?.size,
    (size) => size === 0,
    "live handler abort disconnects its request"
  )
  host.release(active.runId)
  expect(host.current.exited).toBe(false)
  expect(
    host.effects.filter((effect) => effect.runId === active.runId).map((effect) => effect.stage)
  ).toEqual(["first"])
  await host.restart()
  expect((await host.detail(active.runId)).run.status).toBe("cancelled")
  expect(
    host.effects.filter((effect) => effect.runId === active.runId).map((effect) => effect.stage)
  ).toEqual(["first"])
  const delivery = (await host.deliveries(installed.id)).find((row) => row.id === active.deliveryId)
  expect(delivery.status).toBe("dismissed")
  expect(delivery.cancelledAt).toBeGreaterThan(0)
})

test("@critical parked approval cancellation survives restart without publication", async ({
  host,
}) => {
  const installed = await host.install()
  const parked = await host.run(installed.id, { approval: true })
  const waiting = await host.settled(parked.runId, "waiting")
  const interrupt = waiting.interrupts.find(
    (row) => row.type === "bot_approval" && row.status === "pending"
  )
  expect(interrupt).toBeTruthy()
  await host.mutate({
    operation: "automation",
    installationId: installed.id,
    action: "cancel",
    deliveryId: parked.deliveryId,
  })
  await host.restart()
  expect((await host.detail(parked.runId)).run.status).toBe("cancelled")
  const after = await host.detail(parked.runId)
  expect(after.interrupts.find((row) => row.id === interrupt.id).status).not.toBe("pending")
  const late = await host.rpc("execution_run_approval_respond", {
    interruptId: interrupt.id,
    decision: "approve",
  })
  expect(late).toMatchObject({ ok: false, reason: "gone" })
  expect((await host.detail(parked.runId)).run.status).toBe("cancelled")
  expect(
    host.effects.filter((effect) => effect.runId === parked.runId).map((effect) => effect.stage)
  ).toEqual(["first"])
})

test("@critical an uncooperative late handler result cannot overwrite cancellation", async ({
  host,
}) => {
  const installed = await host.install()
  const active = await host.run(installed.id, { barrier: true, ignoreCancellation: true })
  await until(() => host.barriers.has(active.runId), Boolean, "uncooperative handler barrier")
  await host.mutate({
    operation: "automation",
    installationId: installed.id,
    action: "cancel",
    deliveryId: active.deliveryId,
  })
  host.release(active.runId)
  await until(() => host.returned.has(active.runId), Boolean, "late workload actually returned")
  expect(host.current.exited).toBe(false)
  // A bounded negative observation catches a late commit in the still-live
  // process; restarting immediately could hide that commit behind SIGKILL.
  const deadline = Date.now() + 1000
  do {
    const detail = await host.detail(active.runId)
    expect(detail.run.status).toBe("cancelled")
    expect(detail.botResult).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  await host.restart()
  expect((await host.detail(active.runId)).botResult).toBeUndefined()
  expect((await host.detail(active.runId)).run.status).toBe("cancelled")
})

test("@critical a completed durable step is not repeated after a real process crash", async ({
  host,
}) => {
  const installed = await host.install()
  const active = await host.run(installed.id, { barrier: true })
  await until(() => host.barriers.has(active.runId), Boolean, "checkpoint followed by barrier")
  // Kill while the barrier proves that the first step has committed. Release
  // only after the old process is gone, so it cannot race a final effect.
  await host.stop("SIGKILL")
  host.release(active.runId)
  await host.start()
  await host.settled(active.runId)
  expect(
    host.effects.filter((effect) => effect.runId === active.runId).map((effect) => effect.stage)
  ).toEqual(["first", "last"])
  expect(
    (await host.deliveries(installed.id)).filter((row) => row.runId === active.runId)
  ).toHaveLength(1)
})

test("@critical installation rejects replay conflicts, missing slots and use after uninstall", async ({
  host,
}) => {
  const operationId = randomUUID()
  const installed = await host.install({ operationId })
  await expect(host.install({ operationId, paused: true })).rejects.toThrow(/already belongs/)
  await expect(host.install({ operationId, enabled: false })).rejects.toThrow(/already belongs/)
  await expect(
    host.mutate({
      operation: "input_slot",
      installationId: installed.id,
      triggerId: "first",
      slotId: "missing",
    })
  ).rejects.toThrow()
  await expect(
    host.mutate({
      operation: "bind",
      installationId: installed.id,
      slotId: "missing",
      binding: { integrationAccountId: "foreign" },
    })
  ).rejects.toThrow()
  await host.mutate({ operation: "uninstall", installationId: installed.id })
  await expect(host.run(installed.id)).rejects.toThrow()
  expect(host.effects).toHaveLength(0)
})

test("@critical native authentication rejects an invalid service credential before a Bot mutation", async ({
  host,
}) => {
  const token = host.token
  host.token = "invalid-test-token"
  let response
  try {
    response = await host.request("POST", "/internal/_rpc/bot_installation_mutate", {
      operation: "install",
      operationId: randomUUID(),
      definitionId: "bot-e2e:handler",
      version: "1.0.0",
      scope: { kind: "account" },
    })
  } finally {
    host.token = token
  }
  expect(response.status).toBe(401)
  expect((await host.rpc("bot_console_read", { view: "installations" })).rows).toHaveLength(0)
})

const stagesFor = (host, runId) =>
  host.effects.filter((effect) => effect.runId === runId).map((effect) => effect.stage)
async function pendingApproval(host, runId) {
  const detail = await host.settled(runId, "waiting")
  const interrupt = detail.interrupts.find(
    (row) => row.type === "bot_approval" && row.status === "pending"
  )
  expect(interrupt).toBeTruthy()
  return interrupt
}

async function heldInstallations(host, installations) {
  // An occupied pass lets both targets be admitted before the next batch is
  // selected, so that batch starts both barriers concurrently and deterministically.
  const gate = await host.install()
  const blocking = await host.run(gate.id, { barrier: true })
  await until(() => host.barriers.has(blocking.runId), Boolean, "batch admission barrier")
  const runs = []
  for (const installation of installations)
    runs.push(await host.run(installation.id, { barrier: true }))
  host.release(blocking.runId)
  await host.settled(blocking.runId)
  for (const run of runs)
    await until(() => host.barriers.has(run.runId), Boolean, "independent active barrier")
  return runs
}

test("@critical independent approvals survive restart and each authorize exactly one final effect", async ({
  host,
}) => {
  const a = await host.install(),
    b = await host.install()
  const first = await host.run(a.id, { approval: true })
  const approvalA = await pendingApproval(host, first.runId)
  const second = await host.run(b.id, { approval: true })
  const approvalB = await pendingApproval(host, second.runId)
  expect(approvalA.id).not.toBe(approvalB.id)
  await host.restart()
  for (const [run, original] of [
    [first, approvalA],
    [second, approvalB],
  ]) {
    const restored = (await host.detail(run.runId)).interrupts.find((row) => row.id === original.id)
    expect(restored).toMatchObject({ status: "pending", expiresAt: original.expiresAt })
  }
  expect(
    await host.rpc("execution_run_approval_respond", {
      interruptId: approvalA.id,
      decision: "approve",
    })
  ).toMatchObject({ ok: true, status: "approved" })
  await host.settled(first.runId)
  await remains(
    () => host.detail(second.runId),
    (detail) =>
      detail.run.status === "waiting" &&
      detail.interrupts.find((row) => row.id === approvalB.id)?.status === "pending",
    "independent approval remains pending"
  )
  expect(stagesFor(host, second.runId)).toEqual(["first"])
  expect(
    await host.rpc("execution_run_approval_respond", {
      interruptId: approvalA.id,
      decision: "approve",
    })
  ).toMatchObject({ ok: false, reason: "gone" })
  expect(
    await host.rpc("execution_run_approval_respond", {
      interruptId: approvalB.id,
      decision: "approve",
    })
  ).toMatchObject({ ok: true })
  await host.settled(second.runId)
  await host.restart()
  for (const run of [first, second]) {
    expect((await host.detail(run.runId)).run.status).toBe("completed")
    expect(stagesFor(host, run.runId)).toEqual(["first", "last"])
  }
})

test("@critical denying an approval prevents final publication and cannot be reversed after restart", async ({
  host,
}) => {
  const installed = await host.install()
  const run = await host.run(installed.id, { approval: true })
  const approval = await pendingApproval(host, run.runId)
  expect(
    await host.rpc("execution_run_approval_respond", { interruptId: approval.id, decision: "deny" })
  ).toMatchObject({ ok: true, status: "denied" })
  const complete = await host.settled(run.runId)
  expect(complete.botResult.summary).toBe("denied")
  await host.restart()
  expect(
    await host.rpc("execution_run_approval_respond", {
      interruptId: approval.id,
      decision: "approve",
    })
  ).toMatchObject({ ok: false, reason: "gone" })
  await remains(
    () => host.detail(run.runId),
    (detail) =>
      detail.run.status === "completed" &&
      detail.botResult?.summary === "denied" &&
      stagesFor(host, run.runId).join() === "first",
    "denial fences publication"
  )
})

test("@critical approval expiry retains its original deadline through a process restart", async ({
  host,
}) => {
  const installed = await host.install()
  const ttl = 45_000
  const run = await host.run(installed.id, { approval: true, approvalTimeoutMs: ttl })
  const approval = await pendingApproval(host, run.runId)
  const step = (await host.storedRows("botRunSteps")).find(
    (row) => row.runId === run.runId && row.name === "approve"
  )
  expect(approval.expiresAt).toBe(step.startedAt + ttl)
  await host.restart()
  const restored = (await host.detail(run.runId)).interrupts.find((row) => row.id === approval.id)
  expect(restored.expiresAt).toBe(approval.expiresAt)
  expect(Date.now()).toBeLessThan(approval.expiresAt - 750)
  await remains(
    () => host.detail(run.runId),
    (detail) =>
      detail.run.status === "waiting" &&
      detail.interrupts.find((row) => row.id === approval.id)?.status === "pending",
    "approval does not expire before its original deadline"
  )
  const complete = await until(
    () => host.detail(run.runId),
    (detail) => detail.run.status === "completed",
    "original approval deadline",
    ttl + 15_000
  )
  expect(complete.botResult.summary).toBe("expired")
  const expired = complete.interrupts.find((row) => row.id === approval.id)
  expect(expired.status).toBe("expired")
  expect(expired.resolvedAt).toBeGreaterThanOrEqual(approval.expiresAt)
  expect(expired.resolvedAt).toBeLessThanOrEqual(approval.expiresAt + 15_000)
  expect(
    await host.rpc("execution_run_approval_respond", {
      interruptId: approval.id,
      decision: "approve",
    })
  ).toMatchObject({ ok: false })
  expect(stagesFor(host, run.runId)).toEqual(["first"])
})

test("@critical cancelling one queued delivery does not cancel its active sibling or another installation", async ({
  host,
}) => {
  const installed = await host.install(),
    other = await host.install()
  const [active, independent] = await heldInstallations(host, [installed, other])
  const queued = await host.run(installed.id)
  const independentQueued = await host.run(other.id)
  await host.mutate({
    operation: "automation",
    installationId: other.id,
    action: "cancel",
    deliveryId: queued.deliveryId,
  })
  expect(
    (await host.deliveries(installed.id)).find((row) => row.id === queued.deliveryId).status
  ).toBe("pending")
  await host.mutate({
    operation: "automation",
    installationId: installed.id,
    action: "cancel",
    deliveryId: queued.deliveryId,
  })
  expect((await host.detail(active.runId)).run.status).toBe("running")
  expect((await host.detail(independent.runId)).run.status).toBe("running")
  await host.stop("SIGKILL")
  host.release(active.runId)
  host.release(independent.runId)
  await host.start()
  await host.settled(active.runId)
  await host.settled(independent.runId)
  await host.settled(independentQueued.runId)
  await remains(
    () => host.deliveries(installed.id),
    (rows) =>
      rows.find((row) => row.id === queued.deliveryId)?.status === "dismissed" &&
      stagesFor(host, queued.runId).length === 0,
    "queued cancellation stays isolated"
  )
  expect(stagesFor(host, active.runId)).toEqual(["first", "last"])
  expect(stagesFor(host, independent.runId)).toEqual(["first", "last"])
  expect(stagesFor(host, independentQueued.runId)).toEqual(["first", "last"])
})

test("@critical two account bindings preserve colliding provider delivery IDs across restart and redelivery", async ({
  host,
}) => {
  const { producer, accounts } = await accountsFor(host)
  const consumers = []
  for (const account of [accounts.a, accounts.b])
    consumers.push(
      await host.install({
        definitionId: "bot-e2e:bound",
        credentialBindings: {
          a: { integrationAccountId: account },
          b: { integrationAccountId: account },
        },
      })
    )
  const id = randomUUID()
  for (const account of [accounts.a, accounts.b]) await publish(host, producer, account, {}, id)
  const rows = []
  for (const consumer of consumers)
    rows.push(
      await until(
        () => host.deliveries(consumer.id),
        (items) => items.length === 1 && items[0].status === "succeeded",
        "account-specific delivery"
      )
    )
  expect(rows[0][0].eventId).not.toBe(rows[1][0].eventId)
  expect(rows[0][0].runId).not.toBe(rows[1][0].runId)
  const expected = [accounts.a, accounts.b]
  for (let i = 0; i < rows.length; i++)
    expect(
      host.effects
        .filter((effect) => effect.runId === rows[i][0].runId)
        .map((effect) => effect.accountId)
    ).toEqual([expected[i], expected[i]])
  await host.restart()
  for (const account of expected) await publish(host, producer, account, {}, id)
  await remains(
    async () => Promise.all(consumers.map((consumer) => host.deliveries(consumer.id))),
    (current) =>
      current.every(
        (items, i) =>
          items.length === 1 &&
          items[0].runId === rows[i][0].runId &&
          stagesFor(host, items[0].runId).length === 2
      ),
    "account redelivery does not repeat effects"
  )
})

test("@critical disabled installations reject new work without replaying it when enabled", async ({
  host,
}) => {
  const { producer, accounts } = await accountsFor(host)
  const installed = await host.install({
    definitionId: "bot-e2e:bound",
    enabled: false,
    credentialBindings: {
      a: { integrationAccountId: accounts.a },
      b: { integrationAccountId: accounts.b },
    },
  })
  const manual = await host.install({ enabled: false })
  await expect(host.run(manual.id)).rejects.toThrow()
  const ignoredId = randomUUID()
  await publish(host, producer, accounts.a, {}, ignoredId)
  const ignored = (await host.storedRows("integrationEvents")).find(
    (row) => row.deliveryId === ignoredId
  )
  expect(ignored.projectionState).toBe("complete")
  expect(ignored.projection.steps.bots.status).toBe("complete")
  expect(ignored.projection.steps.bots.retryInstallationIds ?? []).toEqual([])
  await host.restart()
  for (const installation of [installed, manual])
    await host.mutate({ operation: "set_enabled", installationId: installation.id, enabled: true })
  await publish(host, producer, accounts.a, {}, ignoredId)
  await remains(
    async () => Promise.all([host.deliveries(installed.id), host.deliveries(manual.id)]),
    (rows) => rows.every((items) => items.length === 0),
    "disabled inputs remain unadmitted"
  )
  const accepted = await host.run(manual.id)
  await host.settled(accepted.runId)
  const newId = randomUUID()
  await publish(host, producer, accounts.a, { probe: newId }, newId)
  const fresh = await until(
    () => host.deliveries(installed.id),
    (rows) => rows.length === 1 && rows[0].status === "succeeded",
    "new input after enable"
  )
  const stored = (await host.storedRows("botEventDeliveries")).find((row) => row.id === fresh[0].id)
  expect(stored.envelope.payload.probe).toBe(newId)
  expect(stagesFor(host, accepted.runId)).toEqual(["first", "last"])
})

test("@critical uninstall dismisses running and queued work while preserving an independent installation", async ({
  host,
}) => {
  const installed = await host.install(),
    independent = await host.install()
  const [active, survivor] = await heldInstallations(host, [installed, independent])
  const queued = await host.run(installed.id)
  const survivorQueued = await host.run(independent.id)
  await host.mutate({ operation: "uninstall", installationId: installed.id })
  await host.settled(active.runId, "cancelled")
  expect((await host.detail(survivor.runId)).run.status).toBe("running")
  await until(
    () => host.barriers.get(active.runId)?.size,
    (size) => size === 0,
    "uninstall disconnects handler"
  )
  await host.restart()
  host.release(survivor.runId)
  await expect(host.run(installed.id)).rejects.toThrow()
  await host.settled(survivor.runId)
  await host.settled(survivorQueued.runId)
  await remains(
    () => host.deliveries(installed.id),
    (rows) =>
      rows.length === 2 &&
      rows.every((row) => row.status === "dismissed") &&
      stagesFor(host, queued.runId).length === 0 &&
      stagesFor(host, active.runId).join() === "first",
    "uninstall prevents old work from resuming"
  )
  expect(stagesFor(host, survivor.runId)).toEqual(["first", "last"])
  expect(stagesFor(host, survivorQueued.runId)).toEqual(["first", "last"])
})
