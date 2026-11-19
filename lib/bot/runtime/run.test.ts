/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { enqueueBotDelivery, listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { installBot } from "@/lib/db/bot-installations"
import {
  BOT_RUN_RESULT_STEP,
  addBotRunExecutionMs,
  completeBotRunStep,
  getBotRunStep,
  putBotRunResult,
  readBotRunExecutionMs,
} from "@/lib/db/bot-run-steps"
import type { BotEventDeliveryRow, BotInstallationRow } from "@/lib/db/bot-types"
import { getExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { InstalledBot } from "@/lib/bot/installed-bot"
import { liveBotRun } from "@/lib/policy/action-review/configured-grants"
import { outboundFingerprint } from "@/lib/policy/action-review/outbound-targets"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

import { BotExecutorUnavailableError, type BotExecutorContext } from "./executors/types"
import { BotRunParkedError } from "./step"
import { pendingParks, recordPendingPark } from "./host-step"
import {
  __resetLiveBotRunsForTesting,
  botRunId,
  cancelBotRun,
  cancelAcceptedBotDeliveries,
  cancelLiveBotInstallation,
  cancelLiveBotRun,
  getLiveBotRunSignal,
  runBotDelivery,
  recordedBotRunMetadata,
} from "./run"

jest.mock("@/lib/db/bot-run-steps", () => {
  const actual = jest.requireActual("@/lib/db/bot-run-steps")
  return {
    ...actual,
    getBotRunStep: jest.fn(actual.getBotRunStep),
    completeBotRunStep: jest.fn(actual.completeBotRunStep),
    putBotRunResult: jest.fn(actual.putBotRunResult),
  }
})
jest.mock("@/lib/bot/sources/bot-run", () => ({ dispatchBotRunToBots: jest.fn() }))
jest.mock("@/lib/workflow/runtime/cancel-run", () => ({
  cancelWorkflowRun: jest.fn().mockResolvedValue({ cancelled: true }),
}))
jest.mock("@/lib/squads/durable/durable-control", () => ({
  controlSquadRun: jest.fn().mockResolvedValue({ accepted: true }),
}))

const NOW = 1_700_000_000_000
const now = () => NOW

function envelope(): BotEventEnvelopeV1 {
  return {
    eventId: "bev_1",
    deliveryId: "bdl_1",
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { number: 42 },
    provenance: { selfProduced: false, depth: 0 },
    actor: { kind: "human", id: "octocat", displayName: "Octocat" },
  }
}

async function seed(): Promise<{ delivery: BotEventDeliveryRow; resolved: InstalledBot }> {
  const installation: BotInstallationRow = await installBot({
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    config: { channel: "#ops" },
    now: NOW,
  })
  const delivery = await enqueueBotDelivery({ envelope: envelope(), now: NOW })
  return {
    delivery,
    resolved: {
      installation,
      definition: {
        id: "acme:digest",
        name: "Digest",
        version: "1.0.0",
        executor: "handler",
        triggers: [{ id: "opened", kind: "manual" }],
        source: "plugin",
      },
      policy: {},
      // The audit trail beside the ceiling. Empty here because no layer has an
      // opinion, which `resolveBotPolicy([])` is the honest way to spell.
      policyResolution: { policy: {}, provenance: {}, refusals: [] },
      problems: [],
    },
  }
}

beforeEach(async () => {
  jest
    .mocked(getBotRunStep)
    .mockReset()
    .mockImplementation(jest.requireActual("@/lib/db/bot-run-steps").getBotRunStep)
  jest
    .mocked(completeBotRunStep)
    .mockReset()
    .mockImplementation(jest.requireActual("@/lib/db/bot-run-steps").completeBotRunStep)
  jest
    .mocked(putBotRunResult)
    .mockReset()
    .mockImplementation(jest.requireActual("@/lib/db/bot-run-steps").putBotRunResult)
  const source = await import("@/lib/bot/sources/bot-run")
  jest.mocked(source.dispatchBotRunToBots).mockReset()
  __resetDbForTesting()
  __resetLiveBotRunsForTesting()
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
  await db.botRunSteps.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
  await db.executionRunInterrupts.clear()
}, 15_000)

/** Let the post-commit publication and other detached work run to completion. */
async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("botRunId", () => {
  it("is derived from the delivery, so a re-entry finds its own state", () => {
    expect(botRunId("bdl_1")).toBe(botRunId("bdl_1"))
    expect(botRunId("bdl_1")).not.toBe(botRunId("bdl_2"))
  })
})

describe("runBotDelivery", () => {
  it("keeps a Bot's cost ledger over a Squad it admits, without refusing remote worker policy", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy = { maxRunCostUsd: 2 }
    const { createSquadRunRecords } = await import("@/lib/squads/squad/squad-run-records")
    const { resolveRunAuthority } = await import("@/lib/execution/run-authority")
    const { readRunBudget } = await import("@/lib/execution/run-ledger")
    const { encodeRemoteWorkerPolicy } = await import("@/lib/squads/workers/remote-worker-policy")
    const handler = jest.fn(async (ctx: BotExecutorContext) => {
      await createSquadRunRecords({
        runId: "r12-pool-squad",
        teamId: "r12-team",
        objective: "Remote work",
        origin: "delegation",
        startedAt: NOW,
        launchedByRunId: ctx.runId,
      })
      const { authority } = await resolveRunAuthority({
        parentRunId: "execution:team:r12-pool-squad",
      })
      expect((await readRunBudget("execution:team:r12-pool-squad"))?.costUsd).toBe(2)
      expect(() => encodeRemoteWorkerPolicy({}, false, undefined, authority)).not.toThrow()
      return { output: {} }
    })
    const outcome = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(outcome.status).toBe("completed")
    expect(handler).toHaveBeenCalledTimes(1)
  })
  it("records integration actors separately and persists the folded Bot authority", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy = {
      maxAuthority: "plan",
      maxRunCostUsd: 2,
      permissionProfile: { outbound: "deny" },
    }
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ output: {} }) },
    })
    const run = await getExecutionRun(outcome.runId)
    expect(run?.actingIdentity).toMatchObject({
      lane: "legacy",
      trigger: "external-event",
      requesters: [],
      eventActors: [
        {
          kind: "event-actor",
          source: "integration",
          externalId: "octocat",
          displayName: "Octocat",
        },
      ],
    })
    expect(run?.authority).toEqual({
      schemaVersion: 1,
      caps: "explicit-v1",
      permissionMode: "plan",
      permissionProfile: { outbound: "deny" },
    })
    expect(run?.runLedger).toMatchObject({ limits: { costUsd: 2 } })
  })

  it("records timed triggers without guessing a schedule's authorizer", async () => {
    const { delivery } = await seed()
    const metadata = recordedBotRunMetadata({
      ...delivery,
      envelope: { ...delivery.envelope, source: "schedule" },
    })
    expect(metadata.actingIdentity).toMatchObject({
      lane: "legacy",
      trigger: "schedule",
      requesters: [],
    })
    expect(metadata.actingIdentity?.authorizingPrincipal).toBeUndefined()
  })

  it.each(["manual", "desktop"] as const)("keeps a %s Bot run non-local", async (source) => {
    const { delivery } = await seed()
    expect(
      recordedBotRunMetadata({ ...delivery, envelope: { ...delivery.envelope, source } })
        .actingIdentity?.trigger
    ).toBe("external-event")
  })

  it("records a connector sender as an event actor, never a requester", async () => {
    const { delivery } = await seed()
    const metadata = recordedBotRunMetadata({
      ...delivery,
      envelope: {
        ...delivery.envelope,
        source: "connector",
        binding: { adapterId: "adapter" },
        payload: { platform: "lark" },
      },
    })
    expect(metadata.actingIdentity).toMatchObject({
      trigger: "external-event",
      requesters: [],
      eventActors: [
        expect.objectContaining({
          kind: "event-actor",
          source: "connector",
          externalId: "octocat",
        }),
      ],
    })
    expect(metadata.actingIdentity?.authorizingPrincipal).toBeUndefined()
  })

  it("keeps cancellation terminal when startup resumes after a checkpoint barrier", async () => {
    const { delivery, resolved } = await seed()
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    jest.mocked(getBotRunStep).mockImplementationOnce(async (...args) => {
      entered()
      await blocker
      return jest.requireActual("@/lib/db/bot-run-steps").getBotRunStep(...args)
    })
    const handler = jest.fn()
    const running = runBotDelivery({ delivery, resolved, now, executors: { handler } })
    await ready
    await cancelAcceptedBotDeliveries(delivery.installationId)
    release()
    expect((await running).status).toBe("cancelled")
    expect(handler).not.toHaveBeenCalled()
    expect(await getExecutionRun(botRunId(delivery.id))).toMatchObject({
      status: "cancelled",
      latestSnapshot: { status: "cancelled" },
    })
  })

  it("does not publish a completed event when cancellation wins before completion commits", async () => {
    const { delivery, resolved } = await seed()
    const source = await import("@/lib/bot/sources/bot-run")
    const running = runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async () => {
          // The cancel commits while the handler is still on its way back.
          await cancelAcceptedBotDeliveries(delivery.installationId)
          return { summary: "late" }
        },
      },
    })
    expect((await running).status).toBe("cancelled")
    await settleAsyncWork()
    expect(source.dispatchBotRunToBots).not.toHaveBeenCalled()
    expect((await getExecutionRun(botRunId(delivery.id)))?.status).toBe("cancelled")
    expect(await getBotRunStep(botRunId(delivery.id), BOT_RUN_RESULT_STEP)).toBeUndefined()
  })

  it("reports the output of the attempt that committed, not of one whose commit failed (B19)", async () => {
    const { delivery, resolved } = await seed()
    jest.mocked(putBotRunResult).mockImplementationOnce(async () => {
      throw new Error("disk write failed")
    })
    const outputs = ["A", "B"]
    const handler = jest.fn(async () => ({ summary: "done", output: outputs.shift() }))
    const first = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(first.status).toBe("failed")
    expect(await getBotRunStep(botRunId(delivery.id), BOT_RUN_RESULT_STEP)).toBeUndefined()

    const retried = (await getDb().botEventDeliveries.get(delivery.id))!
    expect(retried.status).toBe("pending")
    const second = await runBotDelivery({
      delivery: retried,
      resolved,
      now,
      executors: { handler },
    })
    expect(second.status).toBe("completed")
    expect((await getBotRunStep(botRunId(delivery.id), BOT_RUN_RESULT_STEP))?.output).toEqual({
      summary: "done",
      output: "B",
    })
  })

  it("publishes bot.run.failed once a run fails for good, and clears the stage (B05)", async () => {
    const { delivery, resolved } = await seed()
    const source = await import("@/lib/bot/sources/bot-run")
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new Error("403 forbidden")
        },
      },
    })
    expect(outcome.status).toBe("failed")
    await settleAsyncWork()
    expect(source.dispatchBotRunToBots).toHaveBeenCalledWith(
      expect.objectContaining({ runId: outcome.runId, status: "failed", botId: "acme:digest" })
    )
    expect((await getDb().botEventDeliveries.get(delivery.id))?.runPublication).toBeUndefined()
  })

  it("does not publish a failure while the delivery still owns a retry", async () => {
    const { delivery, resolved } = await seed()
    const source = await import("@/lib/bot/sources/bot-run")
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new Error("upstream 500")
        },
      },
    })
    await settleAsyncWork()
    expect(source.dispatchBotRunToBots).not.toHaveBeenCalled()
    expect((await getDb().botEventDeliveries.get(delivery.id))?.runPublication).toBeUndefined()
  })

  it("keeps a completion staged when its dispatch fails, for the runner's flush", async () => {
    const { delivery, resolved } = await seed()
    const source = await import("@/lib/bot/sources/bot-run")
    jest.mocked(source.dispatchBotRunToBots).mockRejectedValueOnce(new Error("router down"))
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ summary: "posted" }) },
    })
    expect(outcome.status).toBe("completed")
    await settleAsyncWork()
    expect((await getDb().botEventDeliveries.get(delivery.id))?.runPublication).toMatchObject({
      status: "completed",
      botId: "acme:digest",
      summary: "posted",
    })
  })

  it("keeps a failed run failed when its dead letter is cancelled (B22)", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new Error("403 forbidden")
        },
      },
    })
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("deadletter")
    expect(await cancelAcceptedBotDeliveries(delivery.installationId, delivery.id)).toBe(1)

    const row = await getDb().botEventDeliveries.get(delivery.id)
    expect(row).toMatchObject({ status: "dismissed", lastError: "cancelled" })
    expect((await getExecutionRun(outcome.runId))?.status).toBe("failed")
    const events = await runEventJournal.replay(outcome.runId)
    expect(events.at(-1)?.type).toBe("run.failed")
    expect(events.some((event) => event.type === "run.cancelled")).toBe(false)
  })

  it("does not commit success for an installation removed while its handler ran (B16)", async () => {
    const { delivery, resolved } = await seed()
    const source = await import("@/lib/bot/sources/bot-run")
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async () => {
          await getDb().botInstallations.delete(delivery.installationId)
          return { summary: "late" }
        },
      },
    })
    expect(outcome.status).toBe("cancelled")
    await settleAsyncWork()
    expect(await getDb().botEventDeliveries.get(delivery.id)).toMatchObject({
      status: "dismissed",
      lastError: "installation was removed",
    })
    expect((await getExecutionRun(outcome.runId))?.status).toBe("cancelled")
    expect(source.dispatchBotRunToBots).not.toHaveBeenCalled()
  })

  it("stops durable Workflow and parked Squad children and does not recancel new work on an operation retry", async () => {
    const { delivery } = await seed()
    const runId = botRunId(delivery.id)
    await getDb().workflowInvocations.put({
      id: "inv",
      runId: "workflow-child",
      idempotencyKey: runId,
    } as never)
    await completeBotRunStep(runId, "squad-start", { started: true, runId }, NOW)
    await cancelAcceptedBotDeliveries(delivery.installationId, undefined, "same-gesture")
    const workflow = await import("@/lib/workflow/runtime/cancel-run")
    const squad = await import("@/lib/squads/durable/durable-control")
    expect(workflow.cancelWorkflowRun).toHaveBeenCalledWith("workflow-child", "Bot cancelled")
    expect(squad.controlSquadRun).toHaveBeenCalledWith({ runId }, "stop")
    await enqueueBotDelivery({
      envelope: { ...envelope(), eventId: "new", deliveryId: "new" },
      now: NOW,
    })
    await cancelAcceptedBotDeliveries(delivery.installationId, undefined, "same-gesture")
    expect((await getDb().botEventDeliveries.get("new"))?.status).toBe("pending")
  })

  it("cancels accepted work before a run exists and refuses later execution", async () => {
    const { delivery, resolved } = await seed()
    expect(await cancelAcceptedBotDeliveries(delivery.installationId)).toBe(1)
    const handler = jest.fn()
    await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(handler).not.toHaveBeenCalled()
    expect(await getDb().botEventDeliveries.get(delivery.id)).toMatchObject({
      status: "dismissed",
      cancelledAt: expect.any(Number),
    })
  })

  it("lets a running attempt finish during pause and keeps the next accepted attempt pending", async () => {
    const { delivery, resolved } = await seed()
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const handler = jest.fn(async () => {
      started()
      await blocker
      return { summary: "done" }
    })
    const running = runBotDelivery({ delivery, resolved, now, executors: { handler } })
    await ready
    const next = await enqueueBotDelivery({
      envelope: { ...envelope(), eventId: "next", deliveryId: "next" },
      now: NOW,
    })
    const { setBotInstallationPaused } = await import("@/lib/db/bot-installations")
    await setBotInstallationPaused(delivery.installationId, true)
    release()
    expect((await running).status).toBe("completed")
    await runBotDelivery({ delivery: next, resolved, now, executors: { handler } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await getDb().botEventDeliveries.get("next"))?.status).toBe("pending")
    await setBotInstallationPaused(delivery.installationId, false)
    expect(
      (await runBotDelivery({ delivery: next, resolved, now, executors: { handler } })).status
    ).toBe("completed")
  })

  it.each(["observe", "human"] as const)("does not run automated work under %s", async (mode) => {
    const { delivery, resolved } = await seed()
    resolved.definition.composition =
      mode === "observe" ? { autonomy: "observe" } : { engagement: "human" }
    const handler = jest.fn()
    const outcome = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(handler).not.toHaveBeenCalled()
    expect(outcome.status).toBe("unavailable")
  })

  it("does not dispatch work after its host has stopped", async () => {
    const { delivery, resolved } = await seed()
    const host = new AbortController()
    host.abort()
    const handler = jest.fn()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      signal: host.signal,
      executors: { handler },
    })
    expect(outcome.status).toBe("cancelled")
    expect(handler).not.toHaveBeenCalled()
    expect((await getDb().botEventDeliveries.get(delivery.id))?.attempts).toBe(0)
  })

  // ADR-0239: a handler Bot's own plugin code may reach the installation's
  // recipients while its run lasts, and no longer.
  it("lends its plugin the installation's recipient list only while it runs", async () => {
    const { delivery, resolved } = await seed()
    const recipient = { kind: "mail" as const, channel: "mail", recipient: "mail:ops@example.com" }
    const listed = {
      ...resolved,
      installation: {
        ...resolved.installation,
        outboundRecipients: [{ recipient, addedAt: 1, addedBy: "local-user" as const }],
      },
    }
    let during: unknown
    let runId = ""
    const outcome = await runBotDelivery({
      delivery,
      resolved: listed,
      now,
      executors: {
        handler: jest.fn(async (ctx: { runId: string }) => {
          runId = ctx.runId
          during = liveBotRun("acme", ctx.runId)?.policyGrants
          return undefined
        }),
      },
    })
    expect(outcome.status).toBe("completed")
    expect(during).toEqual([
      { policyRef: "bot:boti_1", fingerprints: [outboundFingerprint(recipient)] },
    ])
    expect(liveBotRun("acme", runId)).toBeUndefined()
  })

  it("cancels execution at the policy deadline and releases its timer", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy.maxRunDurationMs = 25
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ summary: "aborted" }), {
              once: true,
            })
          }),
      },
    })
    expect(outcome.status).toBe("cancelled")
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("dismissed")
    expect(getLiveBotRunSignal(outcome.runId)).toBeUndefined()
  })

  it("settles at the deadline even when the handler ignores its signal (B14)", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy.maxRunDurationMs = 20
    let finish!: (value: { summary: string }) => void
    const started = Date.now()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      },
    })
    expect(outcome.status).toBe("cancelled")
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("dismissed")
    expect(getLiveBotRunSignal(outcome.runId)).toBeUndefined()
    // The abandoned handler returning later changes nothing.
    finish({ summary: "too late" })
    await settleAsyncWork()
    expect((await getExecutionRun(outcome.runId))?.status).toBe("cancelled")
    expect(await getBotRunStep(outcome.runId, BOT_RUN_RESULT_STEP)).toBeUndefined()
  })

  it("sums execution time across resumed segments instead of restarting the budget (B14)", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy.maxRunDurationMs = 70
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let entries = 0
    const handler = async (ctx: BotExecutorContext) => {
      entries += 1
      await sleep(50)
      if (entries === 1) throw new BotRunParkedError(ctx.runId, "publish", NOW + 20_000)
      return { summary: "finished" }
    }
    const parked = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(parked.status).toBe("parked")
    expect(await readBotRunExecutionMs(parked.runId)).toBeGreaterThanOrEqual(45)

    // 50 ms of the 70 are spent: the second 50 ms segment runs out first.
    const resumed = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(resumed.status).toBe("cancelled")
    expect(entries).toBe(2)
  })

  it("cancels an entry whose budget is already spent without running it", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy.maxRunDurationMs = 1_000
    await addBotRunExecutionMs(botRunId(delivery.id), 1_000)
    const handler = jest.fn(async () => ({ summary: "should not run" }))
    const outcome = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(outcome.status).toBe("cancelled")
    expect(handler).not.toHaveBeenCalled()
  })

  it("does not consume execution time while approval is parked", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy.maxRunDurationMs = 25
    let signal: AbortSignal | undefined
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          signal = ctx.signal
          throw new BotRunParkedError(ctx.runId, "publish", NOW + 60_000)
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(outcome.status).toBe("parked")
    expect(signal?.aborted).toBe(false)
    expect((await getDb().botEventDeliveries.get(delivery.id))?.attempts).toBe(0)
  })

  it("keeps permanent failures terminal and refuses silent redispatch", async () => {
    const { delivery, resolved } = await seed()
    const handler = jest.fn(() => {
      throw new Error("403 forbidden")
    })
    const outcome = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(outcome.status).toBe("failed")
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("deadletter")
    const before = await getExecutionRun(outcome.runId)
    const retry = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(retry.status).toBe("unavailable")
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await getExecutionRun(outcome.runId)).toEqual(before)
  })

  it("preserves progress and verified actor attribution in the shared run journal", async () => {
    const { delivery, resolved } = await seed()
    delivery.envelope.actor = { kind: "human", principalId: "principal", accountId: "account" }
    resolved.installation.projectId = "project"
    await runBotDelivery({
      delivery,
      resolved,
      now,
      cwd: "/fixture",
      executors: {
        handler: async (ctx) => {
          ctx.log("info", "Fetched current revision")
          ctx.log("error", "Verification requires attention", { command: "test" })
          ctx.progress({ message: "Inspecting diff" })
          // A durable step gives asynchronous journal appends time to settle.
          await ctx.step.run("report", () => ({ ok: true }))
          return { summary: "ready" }
        },
      },
    })
    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.projectId).toBe("project")
    expect(run?.initiator).toEqual({ principalId: "principal", accountId: "account" })
    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "step.progress" }),
        expect.objectContaining({ type: "step.failed" }),
        expect.objectContaining({ type: "run.completed" }),
      ])
    )
  })

  it("does not cancel mirrored or non-Bot work through the Bot API", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async () => {
          throw new BotRunParkedError(botRunId(delivery.id), "publish", NOW + 100)
        },
      },
    })
    await getDb().botEventDeliveries.update(delivery.id, { syncedFromHost: true })
    expect(await cancelBotRun(botRunId(delivery.id))).toBe(false)
    expect((await getExecutionRun(botRunId(delivery.id)))?.status).toBe("waiting")
    await getDb().executionRuns.update(botRunId(delivery.id), { kind: "agent-turn" })
    expect(await cancelBotRun(botRunId(delivery.id))).toBe(false)
  })
  it("retains blocked result artifacts and exposes actionable failure without replaying", async () => {
    const { delivery, resolved } = await seed()
    const result = {
      summary: "Fork cannot publish",
      output: { status: "blocked", snapshot: { diff: "+patch" } },
    }
    expect(
      (
        await runBotDelivery({
          delivery,
          resolved,
          now,
          executors: { handler: async () => result },
        })
      ).status
    ).toBe("unavailable")
    expect((await getBotRunStep(botRunId(delivery.id), BOT_RUN_RESULT_STEP))?.output).toEqual(
      result
    )
    expect((await getExecutionRun(botRunId(delivery.id)))?.latestSnapshot?.status).toBe("failed")
  })
  it("settles a turn that needed approval as failed and does not replay it", async () => {
    const { delivery, resolved } = await seed()
    const result = {
      summary: "needs approval: Bash",
      output: {
        sessionId: "s1",
        status: "needs_approval",
        needsApproval: [{ requestId: "r1", toolName: "Bash", at: 1, reason: "x" }],
      },
    }
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => result },
    })
    expect(outcome).toEqual({
      status: "unavailable",
      runId: botRunId(delivery.id),
      error: "needs approval: Bash",
    })
    // The denials stay on the run for whoever clears them.
    expect((await getBotRunStep(botRunId(delivery.id), BOT_RUN_RESULT_STEP))?.output).toEqual(
      result
    )
    expect((await getExecutionRun(botRunId(delivery.id)))?.latestSnapshot?.status).toBe("failed")
    // Dismissed, not backed off: a retry would stop at the same denial.
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("dismissed")
  })
  it("cancels an installation's active execution and keeps its host signal authoritative", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          expect(getLiveBotRunSignal(ctx.runId)?.aborted).toBe(false)
          cancelLiveBotInstallation(resolved.installation.id)
          expect(getLiveBotRunSignal(ctx.runId)?.aborted).toBe(true)
          return { summary: "must not become success" }
        },
      },
    })
    expect(outcome.status).toBe("cancelled")
    expect(getLiveBotRunSignal(outcome.runId)).toBeUndefined()
  })
  it("rejects cancellation of missing and settled runs", async () => {
    expect(await cancelBotRun("missing")).toBe(false)
    const { delivery, resolved } = await seed()
    const result = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({}) },
    })
    expect(await cancelBotRun(result.runId)).toBe(false)
  })
  it("creates a bot ExecutionRun and settles it completed", async () => {
    const { delivery, resolved } = await seed()
    const executor = jest.fn().mockResolvedValue({ summary: "posted" })

    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: executor },
    })

    expect(outcome).toMatchObject({ status: "completed", runId: botRunId(delivery.id) })
    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.kind).toBe("bot")
    expect(run?.status).toBe("completed")
    expect(run?.sourceId).toBe("boti_1")
  })

  it("attributes the run to the verified human behind the event", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({ delivery, resolved, now, executors: { handler: jest.fn() } })

    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.initiator).toMatchObject({ platformIdentityId: "octocat", displayName: "Octocat" })
  })

  it("hands the executor the resolved config, defaults included", async () => {
    const { delivery, resolved } = await seed()
    resolved.definition.configSchema = {
      properties: { channel: { default: "#default" }, limit: { default: 5 } },
    }
    const executor = jest.fn()

    await runBotDelivery({ delivery, resolved, now, executors: { handler: executor } })

    expect(executor.mock.calls[0][0].config).toEqual({ channel: "#ops", limit: 5 })
  })

  it("settles the delivery, so the queue does not retry a success", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({ delivery, resolved, now, executors: { handler: jest.fn() } })

    expect((await listBotDeliveries({ status: "succeeded" })).map((d) => d.id)).toEqual([
      delivery.id,
    ])
  })

  it("backs the delivery off when the work ran and failed", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new Error("upstream 500")
        },
      },
    })

    expect(outcome.status).toBe("failed")
    const row = await getDb().botEventDeliveries.get(delivery.id)
    expect(row?.status).toBe("pending")
    expect(row?.attempts).toBe(1)
    expect((await getExecutionRun(botRunId(delivery.id)))?.status).toBe("waiting")
  })

  it("dismisses rather than retries when nothing could run at all", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new BotExecutorUnavailableError("handler", "plugin is disabled")
        },
      },
    })

    // Retrying the same delivery changes nothing, so the attempt budget is
    // kept for failures a retry could actually fix.
    expect(outcome.status).toBe("unavailable")
    const row = await getDb().botEventDeliveries.get(delivery.id)
    expect(row?.status).toBe("dismissed")
    expect(row?.attempts).toBe(0)
  })

  it("records a cancellation as cancelled, not as a failure", async () => {
    const { delivery, resolved } = await seed()
    const runId = botRunId(delivery.id)

    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          cancelLiveBotRun(ctx.runId)
          await ctx.step.run("after-cancel", () => "never")
        },
      },
    })

    expect(outcome).toEqual({ status: "cancelled", runId })
    expect((await getExecutionRun(runId))?.status).toBe("cancelled")
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("dismissed")
  })

  it("does not retry a terminal transcript cancellation from an agent turn", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async () => {
          throw Object.assign(new Error("operation transcript deleted"), {
            code: "aborted",
            terminalCancellation: true,
          })
        },
      },
    })
    expect(outcome.status).toBe("cancelled")
    expect((await getExecutionRun(outcome.runId))?.status).toBe("cancelled")
    expect(await getDb().botEventDeliveries.get(delivery.id)).toMatchObject({
      status: "dismissed",
      attempts: 0,
    })
  })

  it("reuses the run on a re-entry, so completed steps stay memoized", async () => {
    const { delivery, resolved } = await seed()
    const work = jest.fn().mockResolvedValue("fetched")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          await ctx.step.run("fetch", work)
          throw new Error("crashed after the step")
        },
      },
    }).catch(() => undefined)

    expect(await getBotRunStep(botRunId(delivery.id), "fetch")).toMatchObject({
      status: "completed",
    })

    const retryDelivery = (await getDb().botEventDeliveries.get(delivery.id))!
    await runBotDelivery({
      delivery: retryDelivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          await ctx.step.run("fetch", work)
        },
      },
    })

    // The whole point of deriving the run id from the delivery.
    expect(work).toHaveBeenCalledTimes(1)
    expect((await getExecutionRun(botRunId(delivery.id)))?.latestSnapshot?.status).toBe("completed")
  })

  it("writes a run.started event once, however many attempts there are", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new Error("boom")
        },
      },
    })
    const retry = (await getDb().botEventDeliveries.get(delivery.id))!
    await runBotDelivery({ delivery: retry, resolved, now, executors: { handler: jest.fn() } })

    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(1)
  })

  it("carries a poll cursor forward from the handler's result", async () => {
    const { delivery, resolved } = await seed()
    resolved.definition.triggers = [{ id: "opened", kind: "poll", everyMs: 60_000 }]
    const { readBotTriggerState } = await import("@/lib/db/bot-installations")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ output: { cursor: "page-3" } }) },
    })

    // The host cannot compute a cursor, but remembering the last one is the
    // difference between polling forward and polling the same page forever.
    expect(await readBotTriggerState("boti_1", "opened")).toMatchObject({
      cursor: "page-3",
      lastFiredAt: NOW,
    })
  })

  it("hands each slot the cursor committed before it first ran, and keeps it on retry (B08)", async () => {
    const { delivery, resolved } = await seed()
    resolved.definition.triggers = [{ id: "opened", kind: "poll", everyMs: 60_000 }]
    // Both slots are queued before either has run, as a backlog is.
    const second = await enqueueBotDelivery({
      envelope: { ...envelope(), eventId: "bev_2", deliveryId: "bdl_2" },
      now: NOW,
    })
    const seen: unknown[] = []
    const handler = (cursor: string) => async (ctx: { event: { payload: unknown } }) => {
      seen.push((ctx.event.payload as { cursor?: string }).cursor)
      return { output: { cursor } }
    }

    await runBotDelivery({ delivery, resolved, now, executors: { handler: handler("page-2") } })
    await runBotDelivery({
      delivery: second,
      resolved,
      now,
      executors: {
        handler: async (ctx: { event: { payload: unknown } }) => {
          seen.push((ctx.event.payload as { cursor?: string }).cursor)
          throw new Error("transient")
        },
      },
    })
    // A later slot commits a cursor while the second one is backing off.
    const { writeBotTriggerState } = await import("@/lib/db/bot-installations")
    await writeBotTriggerState("boti_1", "opened", { cursor: "page-9" }, NOW + 5)
    const retry = (await getDb().botEventDeliveries.get(second.id))!
    await runBotDelivery({
      delivery: retry,
      resolved,
      now,
      executors: { handler: handler("page-3") },
    })

    // The first slot reads the empty state, the second the cursor the first
    // committed, and its retry the same page again rather than page-9.
    expect(seen).toEqual([undefined, "page-2", "page-2"])
    expect((await getDb().botEventDeliveries.get(second.id))?.envelope.payload).toEqual({
      number: 42,
    })
  })

  it("carries a derived-state edge forward, so the handler can tell a change", async () => {
    const { delivery, resolved } = await seed()
    resolved.definition.triggers = [
      { id: "opened", kind: "derivedState", everyMs: 60_000, state: "stale" },
    ]
    const { readBotTriggerState } = await import("@/lib/db/bot-installations")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ output: { edgeValue: true } }) },
    })

    expect(await readBotTriggerState("boti_1", "opened")).toMatchObject({ lastEdgeValue: true })
  })

  it("writes no trigger state for a trigger that is not timed", async () => {
    const { delivery, resolved } = await seed()
    const { readBotTriggerState } = await import("@/lib/db/bot-installations")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ output: { cursor: "page-3" } }) },
    })

    // A manual or event trigger has no cursor to carry, and inventing one
    // would make an unrelated output look like scheduler state.
    expect(await readBotTriggerState("boti_1", "opened")).toBeUndefined()
  })

  it("cancelLiveBotRun reports whether the run was running here", async () => {
    expect(cancelLiveBotRun("run_bot_nope")).toBe(false)
  })

  it("clears a pending park recorded by a host call when the attempt settles", async () => {
    const { delivery, resolved } = await seed()
    recordPendingPark(new BotRunParkedError(botRunId(delivery.id), "stale", NOW + 100))
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({}) },
    })
    expect(outcome.status).toBe("completed")
    expect(pendingParks.get(outcome.runId)).toBeUndefined()
  })
})

/**
 * A parked run has not settled. Treating it as a failure would spend an
 * attempt on somebody's thinking time, and closing the journal would leave the
 * resumption unable to write to it.
 */
describe("runBotDelivery when a handler parks", () => {
  it("stops a run resumed on another definition version instead of mixing checkpoints (B12)", async () => {
    const { delivery, resolved } = await seed()
    const handler = jest.fn(async (ctx: BotExecutorContext) => {
      await ctx.step.run("fetch", () => ({ items: 3 }))
      throw new BotRunParkedError(ctx.runId, "publish", NOW + 20_000)
    })
    const parked = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(parked.status).toBe("parked")

    // The plugin updates while the run waits.
    const updated = { ...resolved, definition: { ...resolved.definition, version: "2.0.0" } }
    const resumed = await runBotDelivery({
      delivery,
      resolved: updated,
      now,
      executors: { handler },
    })

    expect(resumed.status).toBe("unavailable")
    expect(resumed).toMatchObject({ error: expect.stringContaining("started on version 1.0.0") })
    // v2's handler never saw v1's `fetch` checkpoint.
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await getExecutionRun(resumed.runId))?.status).toBe("failed")
    // Dismissed, which a replay accepts; it starts a fresh run on 2.0.0.
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("dismissed")
  })

  it("runs a new delivery on the version that exists despite the installation's pin", async () => {
    const { delivery, resolved } = await seed()
    const drifted = {
      ...resolved,
      definition: { ...resolved.definition, version: "2.0.0" },
      problems: [{ kind: "version_drift" as const, pinned: "1.0.0", available: "2.0.0" }],
    }
    const handler = jest.fn(async () => ({ summary: "ran" }))
    const outcome = await runBotDelivery({
      delivery,
      resolved: drifted,
      now,
      executors: { handler },
    })
    expect(outcome.status).toBe("completed")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("does not journal a waiting transition after its delivery lease expires", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          await getDb().botEventDeliveries.update(delivery.id, { leaseExpiresAt: NOW })
          throw new BotRunParkedError(ctx.runId, "publish", NOW + 20_000)
        },
      },
    })

    expect(outcome.status).toBe("cancelled")
    expect((await runEventJournal.replay(outcome.runId)).map((event) => event.type)).not.toContain(
      "run.waiting"
    )
    expect((await getExecutionRun(outcome.runId))?.latestSnapshot?.allowedActions).not.toContain(
      "approve"
    )
  })

  it("keeps the same publication approval actionable after repeated re-entry", async () => {
    const { delivery, resolved } = await seed()
    const detail = { snapshot: { id: "snapshot-1", diff: "approved contents" } }
    const handler = jest.fn(async (ctx: BotExecutorContext) => {
      await ctx.step.waitForApproval("publish", {
        title: "Publish the prepared changes?",
        timeoutMs: 7 * 24 * 60 * 60 * 1_000,
        detail,
      })
    })
    let interruptId: string | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
      // A fixed clock also verifies that occurrence identity is independent
      // of wall-clock precision. Re-entry must not re-create the approval.
      const outcome = await runBotDelivery({
        delivery,
        resolved,
        now,
        stepDeps: { now },
        executors: { handler },
      })
      expect(outcome.status).toBe("parked")
      const run = await getExecutionRun(outcome.runId)
      expect(run?.status).toBe("waiting")
      expect(run?.latestSnapshot?.status).toBe("waiting")
      expect(run?.latestSnapshot?.allowedActions).toEqual([
        "approve",
        "deny",
        "stop",
        "open_details",
      ])
      interruptId ??= run?.latestSnapshot?.pendingInterrupt?.id
      expect(run?.latestSnapshot?.pendingInterrupt?.id).toBe(interruptId)
      expect(await getDb().executionRunInterrupts.count()).toBe(1)
      expect(await getDb().executionRunInterrupts.get(interruptId!)).toMatchObject({
        status: "pending",
        approvalDetail: detail,
        expiresAt: NOW + 7 * 24 * 60 * 60 * 1_000,
      })
      expect((await getDb().botEventDeliveries.get(delivery.id))?.attempts).toBe(0)
    }

    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events.filter((event) => event.type === "run.waiting")).toHaveLength(3)
    expect(events.filter((event) => event.type === "interrupt.requested")).toHaveLength(1)

    // Stopping the recovered run must invalidate this same approval, rather
    // than leave a newly actionable publication behind after cancellation.
    expect(await cancelBotRun(botRunId(delivery.id))).toBe(true)
    const cancelled = await getExecutionRun(botRunId(delivery.id))
    expect(cancelled?.latestSnapshot?.status).toBe("cancelled")
    expect(cancelled?.latestSnapshot?.pendingInterrupt).toBeUndefined()
    expect(cancelled?.latestSnapshot?.allowedActions).not.toContain("approve")
    expect((await getDb().executionRunInterrupts.get(interruptId!))?.status).toBe("expired")
  })

  it("reports parked, leaves the run open, and sets the delivery aside", async () => {
    const { delivery, resolved } = await seed()
    const executor = jest.fn(() => {
      throw new BotRunParkedError(botRunId(delivery.id), "send", NOW + 20_000, "interrupt-1")
    })

    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: executor },
    })

    expect(outcome).toEqual({
      status: "parked",
      runId: botRunId(delivery.id),
      resumeAt: NOW + 20_000,
      waitingFor: "interrupt-1",
    })

    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.status).toBe("waiting")
    // Never ended: the resumption still has to journal into it.
    expect(run?.endedAt).toBeUndefined()

    const [row] = await listBotDeliveries({ installationId: "boti_1" })
    expect(row).toMatchObject({
      status: "parked",
      nextAttemptAt: NOW + 20_000,
      attempts: 0,
    })
  })

  it("journals that it is waiting, so the card says so", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new BotRunParkedError(botRunId(delivery.id), "send", NOW + 20_000)
        },
      },
    })

    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events.map((event) => event.type)).toContain("run.waiting")
  })
})

it("persists the original policy ceiling before dispatch and never widens it on resumed runs", async () => {
  const { delivery, resolved } = await seed()
  resolved.policy = { requireApprovalForWrites: true, maxAutonomy: "confirm" }
  const policies: Array<BotExecutorContext["policy"]> = []
  const handler = async (ctx: BotExecutorContext) => {
    policies.push(ctx.policy)
    throw new BotRunParkedError(botRunId(delivery.id), "wait", NOW + 100)
  }
  await runBotDelivery({ delivery, resolved, now, executors: { handler } })
  expect((await getBotRunStep(botRunId(delivery.id), "__host:policy"))?.output).toEqual(
    resolved.policy
  )
  resolved.policy = { requireApprovalForWrites: false, maxAutonomy: "autopilot" }
  await runBotDelivery({ delivery, resolved, now, executors: { handler } })
  expect(policies[1]).toMatchObject({ maxAutonomy: "confirm", requireApprovalForWrites: true })
  expect((await getBotRunStep(botRunId(delivery.id), "__host:policy"))?.output).toEqual({
    requireApprovalForWrites: true,
    maxAutonomy: "confirm",
  })
})
