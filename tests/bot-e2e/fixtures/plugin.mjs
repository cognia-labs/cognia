// Executable test workload, loaded by the production disk plugin manager.
// External effects stop at the test-owned loopback recorder. No runtime APIs
// are replaced: steps, approvals, child events and cancellation are real.
import manifest from "./plugin.json" with { type: "json" }
let context

export async function handler(run) {
  if (!context) throw new Error("Bot workload lost its activated PluginContext")
  await context.bots.getInstallation(run.runId)
  const input = run.event.payload ?? {}
  if (input.setupAccounts) {
    let accounts = await context.integrations.listAccounts("fixture")
    if (!accounts.length) {
      for (const name of ["a", "b"])
        await context.integrations.createAccount({
          integrationId: "fixture",
          providerId: "fixture",
          authSessionId: `fixture-${name}`,
          remoteAccountId: name,
          label: name,
        })
      accounts = await context.integrations.listAccounts("fixture")
    }
    return {
      output: {
        accounts: accounts.map(({ id, remoteAccountId }) => ({ id, name: remoteAccountId })),
      },
    }
  }
  if (input.publish) {
    const at = new Date().toISOString()
    const event = {
      schemaVersion: 1,
      id: `fixture-${input.publish.accountId}-${input.publish.deliveryId}`,
      pluginId: "bot-e2e",
      integrationId: "fixture",
      accountId: input.publish.accountId,
      deliveryId: input.publish.deliveryId,
      eventType: "ping",
      occurredAt: at,
      receivedAt: at,
      payload: input.publish.payload ?? {},
    }
    await context.integrations.publishEvent(event)
    return { output: { published: event.id } }
  }
  const record = async (stage) => {
    const response = await fetch(`${run.config.recorder}/effect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: run.runId,
        triggerId: run.event.triggerId,
        accountId: run.event.binding?.integrationAccountId,
        stage,
      }),
      signal: run.signal,
    })
    if (!response.ok) throw new Error(`recorder ${response.status}`)
    return response.json()
  }
  const first = await run.step.run("first", () => record("first"))
  if (input.barrier) {
    await fetch(`${run.config.recorder}/barrier/${encodeURIComponent(run.runId)}`, {
      ...(input.ignoreCancellation ? {} : { signal: run.signal }),
    })
    if (input.ignoreCancellation) {
      await fetch(`${run.config.recorder}/returned`, { method: "POST", body: run.runId })
      return { summary: "late result", output: { cancelledWorkReturned: true } }
    }
  }
  if (input.approval) {
    const decision = await run.step.waitForApproval("approve", {
      title: "Bot E2E approval",
      timeoutMs: input.approvalTimeoutMs ?? 120_000,
    })
    if (decision.outcome !== "approved") return { summary: decision.outcome }
  }
  if (input.emit) {
    for (let i = 0; i < (input.emitCopies ?? 1); i++)
      await context.bots.emit(run.runId, {
        type: "bot-e2e.ping",
        payload: { probe: input.emit },
      })
  }
  const last = await run.step.run("last", () => record("last"))
  return { summary: "Bot E2E completed", output: { first, last, triggerId: run.event.triggerId } }
}

const plugin = {
  manifest,
  activate(value) {
    context = value
  },
  deactivate() {
    context = undefined
  },
}

export default plugin
