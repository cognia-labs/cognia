/** Paired browser UI and transport contract. The intercepted Host does not prove Rust authorization. */
import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import { ensureAppMounted, resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { createOwnerPairPayload } from "../mobile/companion-fixture"
import { createMockCompanionServer, type MockCompanionServer } from "../mobile/mock-v2-server"

test.use({ serviceWorkers: "block" })

const BOT_ID = "e2e-host-monitor"
const TRIGGER_ID = "incoming"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLOTS = [
  { id: "slot-a", label: "Work account", integration: "slack", optional: true },
  { id: "slot-b", label: "Sandbox account", integration: "slack", optional: true },
]

let server: MockCompanionServer
test.beforeAll(async () => {
  server = createMockCompanionServer()
  await server.start(0)
})
test.afterAll(async () => {
  await server.stop()
})

async function bootBotConsole(page: Page, supportsAutomation = true) {
  const now = Date.now()
  const installation: BotInstallationRow = {
    id: BOT_ID,
    definitionId: "local-host-monitor",
    definitionSource: "local",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    paused: false,
    config: {},
    credentialBindings: { "slot-a": { adapterId: "work" }, "slot-b": { adapterId: "sandbox" } },
    triggerInputSlots: { [TRIGGER_ID]: "slot-a" },
    createdAt: now,
    updatedAt: now,
  }
  const row: BotConsoleRow = {
    id: BOT_ID,
    definitionId: installation.definitionId,
    source: "local",
    name: "Host monitor",
    executor: "handler",
    status: "enabled",
    paused: false,
    scope: installation.scope,
    orphaned: false,
    problems: [],
    triggers: [
      {
        id: TRIGGER_ID,
        kind: "interaction",
        label: "Incoming messages",
        armed: true,
        acceptsAccount: true,
        inputCredentialSlot: "slot-a",
      },
    ],
    armedTriggers: 1,
    unboundSlots: [],
    requiredSlots: SLOTS,
    credentials: SLOTS.map((slot) => ({
      ...slot,
      bound: true,
      adapterId: slot.id === "slot-a" ? "work" : "sandbox",
    })),
    config: {},
    deadLetters: 0,
    updatedAt: now,
  }
  const mutations: Array<Record<string, unknown>> = []
  const leases: Array<Record<string, unknown>> = []
  let mutationReplies = 0
  let holdProjection = true
  const pendingProjection: Array<() => void> = []
  const project = (update: () => void) => {
    if (holdProjection) pendingProjection.push(update)
    else update()
  }
  await page.goto("/")
  await resetCogniaDb(page)
  server.reset()
  await page.route(`${server.baseUrl}/api/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop()
    const body = request.postDataJSON() as Record<string, unknown>
    const reply = (result: unknown) =>
      route.fulfill({ json: { requestId: crypto.randomUUID(), result } })
    if (command === "host_feature_manifest") {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      const payload = await response.json()
      payload.result.features = {
        "bots.control": { version: 1, operations: ["bot_console_read", "bot_installation_mutate"] },
        ...(supportsAutomation
          ? { "bots.automation": { version: 1, operations: ["bot_installation_mutate"] } }
          : {}),
      }
      payload.result.operations = ["bot_console_read", "bot_installation_mutate"].map((name) => ({
        name,
        feature: "bots.control",
        featureVersion: 1,
        healthy: true,
      }))
      payload.result.deviceGrants = ["host.observe", "host.admin", "workspace.write"]
      payload.result.transportCapabilities = { eventStreamReady: 1 }
      return route.fulfill({ response, json: payload })
    }
    if (command === "bot_console_read") {
      if (body.view === "installations") return reply({ rows: [row] })
      if (body.view === "catalog") return reply({ entries: [] })
      if (body.view === "credentials") return reply({ groups: {} })
      throw new Error(`Unexpected Bot read view ${String(body.view)}`)
    }
    if (command === "host_admin_lease_issue") {
      expect(body).toMatchObject({ operations: ["bot_installation_mutate"], ttlSeconds: 600 })
      leases.push(body)
      return reply({
        token: `bot-lease-${leases.length}`,
        operations: body.operations,
        expiresAt: Date.now() + 600_000,
      })
    }
    if (command === "bot_installation_mutate") {
      expect(supportsAutomation).toBe(true)
      expect(body.installationId).toBe(BOT_ID)
      expect(body.operationId).toMatch(UUID)
      expect(request.headers()["idempotency-key"]).toBe(body.operationId)
      expect(body.adminLease).toBe(`bot-lease-${leases.length}`)
      mutations.push(body)
      if (
        body.operation === "automation" &&
        ["pause", "resume", "cancel"].includes(String(body.action))
      ) {
        if (body.action !== "cancel") {
          const paused = body.action === "pause"
          installation.paused = paused
          project(() => {
            row.paused = paused
          })
        }
      } else if (body.operation === "input_slot" && body.triggerId === TRIGGER_ID) {
        expect(["slot-a", "slot-b", null]).toContain(body.slotId)
        installation.triggerInputSlots = body.slotId ? { [TRIGGER_ID]: String(body.slotId) } : {}
        project(() => {
          row.triggers = [
            {
              ...row.triggers[0],
              inputCredentialSlot: body.slotId ? String(body.slotId) : undefined,
            },
          ]
        })
      } else throw new Error(`Unexpected Bot mutation ${String(body.operation)}`)
      await reply(installation)
      mutationReplies += 1
      return
    }
    return route.continue()
  })
  await page.routeWebSocket(/\/ws\/events(?:\?|$)/, async (socket) => {
    const ticket = new URL(socket.url()).searchParams.get("ticket")
    const redeemed = await page.request.post(`${server.baseUrl}/__control/redeem-ticket`, {
      data: { ticket, path: "/ws/events", audience: "events" },
    })
    expect(redeemed.ok()).toBe(true)
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as { type?: string; channels?: string[] }
      if (frame.type === "subscribe") {
        socket.send(JSON.stringify({ type: "subscribed", channels: frame.channels ?? [] }))
        socket.send(JSON.stringify({ type: "stream_ready", cursor: 0 }))
      }
    })
  })
  await page.evaluate(async (invitation) => {
    if (!window.__cogniaE2ECompanion) throw new Error("Companion fixture bridge unavailable")
    await window.__cogniaE2ECompanion.pair(invitation)
  }, createOwnerPairPayload(server.baseUrl))
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-10-28T00:00:00.000Z" },
  })
  await page.goto("about:blank")
  await page.goto(`/bots?bot=${BOT_ID}`, { waitUntil: "domcontentloaded" })
  await ensureAppMounted(page)
  await expect(page.getByRole("button", { name: "Pause intake", exact: true })).toBeVisible()
  return {
    mutations,
    leases,
    mutationReplies: () => mutationReplies,
    releaseProjection: () => {
      holdProjection = false
      for (const update of pendingProjection.splice(0)) update()
    },
  }
}

test.describe("Bot control plane — paired browser", () => {
  test("@critical persists owner-routed pause and input binding across reload", async ({
    page,
  }) => {
    const host = await bootBotConsole(page)
    await page.getByRole("button", { name: "Pause intake", exact: true }).click()
    await expect.poll(host.mutationReplies).toBe(1)
    await expect(page.getByRole("button", { name: "Pause intake", exact: true })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Resume intake", exact: true })).toHaveCount(0)
    host.releaseProjection()
    await expect(page.getByRole("button", { name: "Resume intake", exact: true })).toBeEnabled()
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Resume intake", exact: true })).toBeEnabled()
    const input = page.getByRole("combobox", { name: "Input account slot for Incoming messages" })
    await expect(input).toHaveValue("slot-a")
    await input.selectOption("slot-b")
    await expect
      .poll(() => host.mutations.filter((body) => body.operation === "input_slot").length)
      .toBe(1)
    await expect(input).toHaveValue("slot-b")
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(input).toHaveValue("slot-b")
    await page.getByRole("button", { name: "Resume intake", exact: true }).click()
    await expect(page.getByRole("button", { name: "Pause intake", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Cancel accepted work", exact: true }).click()
    await expect.poll(() => host.mutations.length).toBe(4)
    expect(
      host.mutations.map(({ operation, action, triggerId, slotId }) => ({
        operation,
        action,
        triggerId,
        slotId,
      }))
    ).toEqual([
      { operation: "automation", action: "pause" },
      { operation: "input_slot", triggerId: TRIGGER_ID, slotId: "slot-b" },
      { operation: "automation", action: "resume" },
      { operation: "automation", action: "cancel" },
    ])
    expect(host.leases).toHaveLength(4)
    expect(new Set(host.mutations.map((body) => body.operationId)).size).toBe(4)
  })

  test("@critical refuses automation controls when the Host lacks the feature", async ({
    page,
  }) => {
    const host = await bootBotConsole(page, false)
    await expect(page.getByRole("button", { name: "Pause intake", exact: true })).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Cancel accepted work", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole("combobox", { name: "Input account slot for Incoming messages" })
    ).toBeDisabled()
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Pause intake", exact: true })).toBeDisabled()
    expect(host.mutations).toEqual([])
    expect(host.leases).toEqual([])
  })
})
