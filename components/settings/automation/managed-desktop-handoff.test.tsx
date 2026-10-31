// Read the new split messages directly; aggregate regeneration belongs to the orchestrator.
const mockPiiClean = jest.fn((_value: unknown) => true)
jest.mock("@cognia/redact", () => ({
  ...jest.requireActual("@cognia/redact"),
  hasNoLeakingPiiDeep: (value: unknown) => mockPiiClean(value),
}))
jest.mock("next-intl", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const Context = React.createContext<Record<string, unknown>>({})
  return {
    NextIntlClientProvider: ({
      messages,
      children,
    }: {
      messages: Record<string, unknown>
      children: React.ReactNode
    }) => React.createElement(Context.Provider, { value: messages }, children),
    useTranslations: (namespace: string) => {
      const messages = React.useContext(Context)
      return (key: string, values?: Record<string, unknown>) => {
        const result = `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (value, part) =>
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined,
            messages
          )
        if (typeof result !== "string") throw new Error(`Missing translation: ${namespace}.${key}`)
        return result.replace(/\{(\w+)\}/g, (_, name: string) =>
          String(values?.[name] ?? `{${name}}`)
        )
      }
    },
  }
})
import { selectOption } from "@/lib/testing/select-option"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import acceptance from "@/i18n/messages/en/managedAcceptance.json"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: jest.fn((selector) => selector({ locked: false, unlockedAccountId: "owner" })),
}))
jest.mock("@/lib/automation/managed-desktop-handoff-client", () => ({
  ...jest.requireActual("@/lib/automation/managed-desktop-handoff-client"),
  managedDesktopHandoffClient: {
    deliveries: jest.fn(),
    prepare: jest.fn(),
    acceptanceStart: jest.fn(),
    acceptanceAttach: jest.fn(),
    acceptanceCancel: jest.fn(),
  },
  watchManagedDesktopAcceptance: jest.fn(() => jest.fn()),
  managedDesktopHandoffErrorKey: jest.fn(() => "prepareFailed"),
}))
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  managedDesktopIdentityScope: jest.fn(() => ({ assertActive: jest.fn(), dispose: jest.fn() })),
}))
jest.mock("@/lib/automation/managed-desktop-acceptance-request", () => ({
  consumeAcceptancePanelRequest: jest.fn(),
  subscribeAcceptancePanelRequest: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/chat/attached-session", () => ({ createAttachedSession: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(), updateSession: jest.fn() }))
jest.mock("@/lib/tasks/spawn-task-dispatch", () => ({ revealSpawnedTask: jest.fn() }))
jest.mock("@/lib/sandbox/managed-desktop-binding", () => ({
  managedDesktopConnectionId: (id: string, generation: number) => `managed:${id}:${generation}`,
  reconcileManagedDesktopBindings: jest.fn(),
}))
jest.mock("@/components/shared/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm: jest.fn().mockResolvedValue(true), dialog: null }),
}))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession: jest.fn() }) },
}))
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => ({ setSelectedGuild: jest.fn() }) },
}))
import { createAttachedSession } from "@/lib/chat/attached-session"
import { getSession, updateSession } from "@/lib/db/sessions"
import { revealSpawnedTask } from "@/lib/tasks/spawn-task-dispatch"
import { reconcileManagedDesktopBindings } from "@/lib/sandbox/managed-desktop-binding"
import { consumeAcceptancePanelRequest } from "@/lib/automation/managed-desktop-acceptance-request"
import {
  watchManagedDesktopAcceptance,
  type ManagedDesktopAcceptanceRun,
} from "@/lib/automation/managed-desktop-handoff-client"
import { useAccountStore } from "@/stores/account/account-store"
import { managedDesktopHandoffClient } from "@/lib/automation/managed-desktop-handoff-client"
import type {
  ManagedDesktopConfigSummary,
  ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"
import { ManagedDesktopHandoff } from "./managed-desktop-handoff"

const api = managedDesktopHandoffClient as jest.Mocked<typeof managedDesktopHandoffClient>
const t = messages.handoff
const target: ManagedDesktopTarget = { kind: "remote", hostId: "chosen-host" }
const config: ManagedDesktopConfigSummary = {
  id: "provider",
  ownerPrincipalId: "owner",
  hostId: "host",
  enabled: true,
  canCreate: false,
  canPrepareTemplate: false,
  qualification: "unqualified",
  isolationTier: "vm",
  egressTier: "off",
  egressEnforcement: "unverified",
  maxConcurrent: 2,
  maxLifetimeSeconds: 3600,
  idleTimeoutSeconds: 600,
  cpuCount: 2,
  memoryMb: 4096,
  revision: 3,
  credentialGeneration: 1,
  credentialPresent: true,
  plan: {
    maxLifetimeSeconds: 3600,
    observedAt: 1,
    expiresAt: 2,
    source: "billing page",
    namespace: "team",
  },
  price: {
    currency: "USD",
    hourlyRateMicros: 165_600,
    observedAt: 1,
    expiresAt: 2,
    source: "pricing page",
  },
  isolationMinimum: "vm" as const,
  enablement: { manualGui: false, agentControl: false, acceptance: false },
  qualificationCategories: (
    ["lifecycle", "control", "authority", "workload", "commit", "bundle"] as const
  ).map((category) => ({ category, current: false, observedAt: null })),
}
const delivery = {
  id: "delivery",
  revision: 8,
  commit: "a".repeat(40),
  branch: "task",
  modes: ["commit", "bundle"] as ("commit" | "bundle")[],
  createdAt: 1,
}
const proposal = {
  id: "proposal",
  deliveryId: delivery.id,
  deliveryRevision: 8,
  mode: "commit" as const,
  commit: delivery.commit,
  expiresAt: 2_000_000_000_000,
  executionEnabled: false as const,
  dormantReason: "managed_desktop_handoff_requires_results_qualification" as const,
  quote: {
    id: "quote",
    providerConfigId: config.id,
    lifetimeSeconds: 3600,
    expiresAt: 2_000_000_000_000,
    currency: "USD",
    hourlyRateMicros: 165600,
    maximumComputeCostMicros: 165600,
    priceObservedAt: 1,
    cpuCount: 2,
    memoryMb: 4096,
    configRevision: 1,
  },
}
function panel(selectedTarget = target) {
  return (
    <NextIntlClientProvider
      locale="en"
      messages={{ managedAcceptance: acceptance, settings: { managedDesktops: messages } }}
    >
      <ManagedDesktopHandoff target={selectedTarget} config={config} />
    </NextIntlClientProvider>
  )
}
async function fill() {
  fireEvent.click(screen.getByRole("button", { name: t.load }))
  await screen.findByLabelText(t.delivery)
  await selectOption(screen.getByLabelText(t.delivery), delivery.id)
  fireEvent.change(screen.getByLabelText("Criterion 1"), {
    target: { value: "Login works" },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({ locked: false, unlockedAccountId: "owner" })
  )
  api.deliveries.mockResolvedValue([delivery])
  api.prepare.mockResolvedValue(proposal)
  jest.mocked(getSession).mockResolvedValue({ id: "parent" } as never)
  jest.mocked(createAttachedSession).mockResolvedValue({ id: "child" } as never)
  api.acceptanceStart.mockResolvedValue(run())
  api.acceptanceAttach.mockResolvedValue(run({ state: "running", childAttached: true }))
  api.acceptanceCancel.mockResolvedValue(run({ state: "cancelled" }))
  jest.mocked(consumeAcceptancePanelRequest).mockReturnValue(undefined)
})

test("mount labels all dormant axes and does not fetch, prepare or start acceptance", () => {
  render(panel())
  expect(screen.getByText(acceptance.localOnly)).toBeVisible()
  expect(screen.getByText(t.sourceScope)).toBeVisible()
  expect(screen.getByText(t.unsupported)).toBeVisible()
  expect(screen.getByRole("button", { name: acceptance.start })).toBeDisabled()
  expect(api.deliveries).not.toHaveBeenCalled()
  expect(api.prepare).not.toHaveBeenCalled()
})

test("user prepares exact source, explicit files and argv on selected Host and sees bounded cost", async () => {
  render(panel())
  await fill()
  await selectOption(screen.getByLabelText(t.mode), "bundle")
  fireEvent.change(screen.getByLabelText(t.files), { target: { value: "acceptance/login.md" } })
  fireEvent.change(screen.getByLabelText(t.argv), { target: { value: '["npm","run","test"]' } })
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  expect(await screen.findByRole("status")).toHaveTextContent("USD 0.1656/hour")
  expect(screen.getByRole("status")).toHaveTextContent(
    "Maximum desktop compute within this deadline: USD 0.1656"
  )
  expect(screen.getByRole("status")).toHaveTextContent(delivery.commit)
  expect(api.prepare).toHaveBeenCalledWith(target, {
    deliveryId: delivery.id,
    deliveryRevision: 8,
    mode: "bundle",
    providerConfigId: config.id,
    lifetimeSeconds: 3600,
    criteria: [{ description: "Login works", screenshotRequired: false }],
    acceptanceFiles: ["acceptance/login.md"],
    argv: ["npm", "run", "test"],
  })
  expect(screen.getByRole("button", { name: acceptance.start })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("Criterion 1"), {
    target: { value: "Different criterion" },
  })
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
})

test("invalid command or overlong deadline cannot prepare, while [] explicitly skips launch", async () => {
  render(panel())
  await fill()
  expect(screen.getByRole("button", { name: t.prepare })).toBeEnabled()
  fireEvent.change(screen.getByLabelText(t.argv), {
    target: { value: "npm run test && curl private" },
  })
  expect(screen.getByRole("button", { name: t.prepare })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(t.argv), {
    target: { value: '["sh","-c","echo private"]' },
  })
  expect(screen.getByRole("button", { name: t.prepare })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(t.argv), { target: { value: "[]" } })
  fireEvent.change(screen.getByLabelText(t.lifetime), { target: { value: "61" } })
  expect(screen.getByRole("button", { name: t.prepare })).toBeDisabled()
  expect(api.prepare).not.toHaveBeenCalled()
})

test("Host failure uses translated refusal and preserves disabled execution", async () => {
  api.prepare.mockRejectedValue(new Error("private source path"))
  render(panel())
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  expect(await screen.findByRole("alert")).toHaveTextContent(t.prepareFailed)
  expect(screen.queryByText("private source path")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: acceptance.start })).toBeDisabled()
})

test("switching Host removes its source list and ignores a pending proposal", async () => {
  let resolve!: (value: typeof proposal) => void
  api.prepare.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const view = render(panel())
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  view.rerender(panel({ kind: "remote", hostId: "other-host" }))
  resolve(proposal)
  await waitFor(() => expect(screen.getByRole("button", { name: t.load })).toBeEnabled())
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.queryByLabelText(t.delivery)).not.toBeInTheDocument()
})

test("account change removes previously prepared private metadata", async () => {
  const view = render(panel())
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  await screen.findByRole("status")
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({ locked: false, unlockedAccountId: "other" })
  )
  view.rerender(panel())
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.queryByLabelText(t.delivery)).not.toBeInTheDocument()
})

function run(patch: Partial<ManagedDesktopAcceptanceRun> = {}): ManagedDesktopAcceptanceRun {
  return {
    acceptanceId: "acceptance",
    providerConfigId: config.id,
    deliveryId: delivery.id,
    commit: delivery.commit,
    mode: "commit",
    state: "provisioning",
    desktopId: "desktop",
    desktopGeneration: 2,
    deadlineAt: Date.now() + 60000,
    delegationId: null,
    childAttached: false,
    source: { sessionId: "parent", taskId: "task", parentRunId: "parent-run" },
    errorCode: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    ...patch,
  }
}
async function prepareLocal() {
  api.prepare.mockResolvedValue({ ...proposal, executionEnabled: true, dormantReason: null })
  render(panel({ kind: "local" }))
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  await screen.findByText(acceptance.confirmCost)
}
function notify(next: ManagedDesktopAcceptanceRun[]) {
  const calls = jest.mocked(watchManagedDesktopAcceptance).mock.calls
  calls[calls.length - 1][1](next)
}
test("shared controls: cost consent stays an explicit checkbox gate before starting", async () => {
  const user = userEvent.setup()
  await prepareLocal()
  const checkbox = screen.getByRole("checkbox", { name: acceptance.confirmCost })
  const start = screen.getByRole("button", { name: acceptance.start })
  expect(checkbox).toHaveAttribute("data-slot", "checkbox")
  expect(start).toBeDisabled()
  await user.click(screen.getByText(acceptance.confirmCost))
  expect(checkbox).toBeChecked()
  expect(start).toBeEnabled()
  expect(api.acceptanceStart).not.toHaveBeenCalled()
  checkbox.focus()
  await user.keyboard(" ")
  expect(checkbox).not.toBeChecked()
  expect(start).toBeDisabled()
  await user.click(checkbox)
  await user.click(start)
  await waitFor(() => expect(api.acceptanceStart).toHaveBeenCalledTimes(1))
})
test("criteria that would leak personal data are refused before anything is billed", async () => {
  await prepareLocal()
  mockPiiClean.mockReturnValueOnce(false)
  fireEvent.click(screen.getByRole("checkbox", { name: acceptance.confirmCost }))
  fireEvent.click(screen.getByRole("button", { name: acceptance.start }))
  expect(await screen.findByText(acceptance.criteriaSensitive)).toBeInTheDocument()
  expect(mockPiiClean).toHaveBeenCalledWith([
    { description: "Login works", screenshotRequired: false },
  ])
  expect(api.acceptanceStart).not.toHaveBeenCalled()
})
test("a human must confirm a current quote; Start creates one child only after awaitingSession", async () => {
  await prepareLocal()
  expect(screen.getByRole("button", { name: acceptance.start })).toBeDisabled()
  fireEvent.click(screen.getByRole("checkbox", { name: acceptance.confirmCost }))
  fireEvent.click(screen.getByRole("button", { name: acceptance.start }))
  await waitFor(() => expect(api.acceptanceStart).toHaveBeenCalledTimes(1))
  expect(api.acceptanceStart).toHaveBeenCalledWith(
    { kind: "local" },
    expect.objectContaining({
      quoteId: "quote",
      idempotencyKey: expect.any(String),
      criteria: [{ description: "Login works", screenshotRequired: false }],
    })
  )
  expect(createAttachedSession).not.toHaveBeenCalled()
  await import("@testing-library/react").then(({ act }) =>
    act(async () => notify([run({ state: "awaitingSession" })]))
  )
  await waitFor(() => expect(revealSpawnedTask).toHaveBeenCalledWith("parent", "child"))
  expect(createAttachedSession).toHaveBeenCalledWith(
    expect.objectContaining({
      parentSessionId: "parent",
      title: "Acceptance: task",
      context: { mode: "none" },
      workspace: "shared",
      extra: { managedAcceptance: { acceptanceId: "acceptance" } },
      prompt: expect.stringContaining("criterion-0: Login works"),
    })
  )
  expect(api.acceptanceAttach).toHaveBeenCalledWith({ kind: "local" }, "acceptance", "child")
  expect(reconcileManagedDesktopBindings).toHaveBeenCalled()
  expect(updateSession).toHaveBeenCalledWith("child", {
    computerUseTarget: { connectionId: "managed:desktop:2" },
  })
})
test.each(["source", "create", "attach", "binding", "update", "open"])(
  "%s failure cancels the started run and suppresses duplicate child creation",
  async (step) => {
    if (step === "source") jest.mocked(getSession).mockResolvedValueOnce(undefined)
    if (step === "create")
      jest.mocked(createAttachedSession).mockRejectedValueOnce(new Error("private path"))
    if (step === "attach") api.acceptanceAttach.mockRejectedValueOnce(new Error("private path"))
    if (step === "binding")
      jest.mocked(reconcileManagedDesktopBindings).mockRejectedValueOnce(new Error("private path"))
    if (step === "update")
      jest.mocked(updateSession).mockRejectedValueOnce(new Error("private path"))
    if (step === "open")
      jest.mocked(revealSpawnedTask).mockImplementationOnce(() => {
        throw new Error("private path")
      })
    api.acceptanceStart.mockResolvedValue(run({ state: "awaitingSession" }))
    await prepareLocal()
    fireEvent.click(screen.getByRole("checkbox", { name: acceptance.confirmCost }))
    fireEvent.click(screen.getByRole("button", { name: acceptance.start }))
    await waitFor(() =>
      expect(api.acceptanceCancel).toHaveBeenCalledWith({ kind: "local" }, "acceptance")
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      step === "source" ? acceptance.sourceMissing : acceptance.runFailed
    )
    expect(screen.queryByText("private path")).not.toBeInTheDocument()
  }
)
test("expired quotes never enable Start and screenshot toggles invalidate the prepared proposal", async () => {
  api.prepare.mockResolvedValue({
    ...proposal,
    executionEnabled: true,
    dormantReason: null,
    expiresAt: 1,
  })
  render(panel({ kind: "local" }))
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  await screen.findByText(acceptance.quoteExpired)
  fireEvent.click(screen.getByRole("checkbox", { name: acceptance.confirmCost }))
  expect(screen.getByRole("button", { name: acceptance.start })).toBeDisabled()
  fireEvent.click(screen.getByRole("checkbox", { name: "Screenshot required for criterion 1" }))
  expect(screen.queryByText(acceptance.confirmCost)).not.toBeInTheDocument()
  expect(api.acceptanceStart).not.toHaveBeenCalled()
})
test("a proposal prefill loads the selected delivery and criteria without prepare or start", async () => {
  jest.mocked(consumeAcceptancePanelRequest).mockReturnValueOnce({
    deliveryId: delivery.id,
    criteria: [{ description: "Prefilled", screenshotRequired: true }],
  })
  render(panel({ kind: "local" }))
  expect(await screen.findByDisplayValue("Prefilled")).toBeVisible()
  expect(
    screen.getByRole("checkbox", { name: "Screenshot required for criterion 1" })
  ).toBeChecked()
  expect(api.prepare).not.toHaveBeenCalled()
  expect(api.acceptanceStart).not.toHaveBeenCalled()
})
test("a live run shows its state/deadline and destructive cancellation uses the Host", async () => {
  render(panel({ kind: "local" }))
  await import("@testing-library/react").then(({ act }) =>
    act(async () => notify([run({ state: "running", childAttached: true })]))
  )
  expect(screen.getByRole("status")).toHaveTextContent("Running")
  expect(screen.getByRole("status")).toHaveTextContent("Hard deadline:")
  fireEvent.click(screen.getByRole("button", { name: acceptance.cancel }))
  await waitFor(() =>
    expect(api.acceptanceCancel).toHaveBeenCalledWith({ kind: "local" }, "acceptance")
  )
})
