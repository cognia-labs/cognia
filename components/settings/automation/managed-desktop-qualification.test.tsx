// The global mock fixes English; respect each fixture provider to verify both locales.
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
// jsdom cannot drive the desktop Radix picker; the HTML select API is what the panel uses.
jest.mock("@/components/ui/native-select", () => ({
  NativeSelect: (props: React.ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: React.ComponentProps<"option">) => <option {...props} />,
}))
const confirm = jest.fn()
jest.mock("@/components/shared/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm, dialog: null }),
}))
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  ...jest.requireActual("@/lib/automation/managed-desktop-client"),
  managedDesktopClient: {
    qualifyStart: jest.fn(),
    qualifyApprove: jest.fn(),
    qualifyCancel: jest.fn(),
  },
}))
jest.mock("@/lib/automation/managed-desktop-handoff-client", () => ({
  managedDesktopHandoffClient: { deliveries: jest.fn() },
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
import zhMessages from "@/i18n/messages/zh-CN/settings/managedDesktops.json"
import {
  managedDesktopClient,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopQualificationRun,
} from "@/lib/automation/managed-desktop-client"
import { managedDesktopHandoffClient } from "@/lib/automation/managed-desktop-handoff-client"
import { ManagedDesktopQualification } from "./managed-desktop-qualification"

const api = managedDesktopClient as jest.Mocked<typeof managedDesktopClient>
const deliveries = managedDesktopHandoffClient.deliveries as jest.Mock
const q = messages.qualification
const target = { kind: "remote" as const, hostId: "host" }
const categories = ["lifecycle", "control", "authority", "workload", "commit", "bundle"] as const

const config = {
  id: "byo",
  credentialPresent: true,
  qualificationCategories: categories.map((category) => ({
    category,
    current: category === "lifecycle",
    observedAt: category === "lifecycle" ? Date.UTC(2026, 9, 29) : null,
  })),
} as unknown as ManagedDesktopConfigSummary

const quote = {
  id: "quote-1",
  providerConfigId: "byo",
  configRevision: 3,
  lifetimeSeconds: 120,
  expiresAt: Date.now() + 60_000,
  currency: "USD",
  hourlyRateMicros: 165_600,
  maximumComputeCostMicros: 5_520,
  priceObservedAt: 1,
  cpuCount: 2,
  memoryMb: 4096,
}

function run(overrides: Partial<ManagedDesktopQualificationRun> = {}) {
  return {
    runId: "run-1",
    providerConfigId: "byo",
    configRevision: 3,
    scope: "gui",
    state: "running",
    currentCategory: "lifecycle",
    awaitingApproval: null,
    categories: categories.slice(0, 4).map((category) => ({
      category,
      state: category === "lifecycle" ? "running" : "pending",
      errorCode: null,
    })),
    handoff: null,
    errorCode: null,
    startedAt: Date.UTC(2026, 9, 29),
    updatedAt: Date.UTC(2026, 9, 29),
    finishedAt: null,
    ...overrides,
  } as ManagedDesktopQualificationRun
}

function renderPanel(
  runs: ManagedDesktopQualificationRun[] = [],
  props: { config?: ManagedDesktopConfigSummary } = {},
  locale: typeof messages = messages
) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: locale } }}>
      <ManagedDesktopQualification target={target} config={props.config ?? config} runs={runs} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  confirm.mockResolvedValue(true)
  api.qualifyStart.mockResolvedValue(run())
  api.qualifyApprove.mockResolvedValue(run())
  api.qualifyCancel.mockResolvedValue(run({ state: "cancelled" }))
})

test("shows which category receipts are current", () => {
  renderPanel()
  const lifecycle = document.querySelector("[data-receipt='lifecycle']")
  expect(lifecycle).toHaveAttribute("data-current", "true")
  expect(lifecycle).toHaveTextContent("Current · 2026-10-29T00:00:00.000Z")
  expect(document.querySelector("[data-receipt='bundle']")).toHaveTextContent(q.receiptMissing)
  expect(screen.getByText(q.empty)).toBeInTheDocument()
})

test("a GUI run starts with the configuration and scope only", async () => {
  renderPanel()
  fireEvent.click(screen.getByRole("button", { name: q.start }))
  await waitFor(() =>
    expect(api.qualifyStart).toHaveBeenCalledWith(target, {
      providerConfigId: "byo",
      scope: "gui",
    })
  )
})

test("an acceptance run needs a handoff-ready delivery and an npm script name", async () => {
  deliveries.mockResolvedValue([
    {
      id: "both",
      revision: 1,
      commit: "a".repeat(40),
      branch: "feat",
      modes: ["commit", "bundle"],
      createdAt: 1,
    },
    {
      id: "commit-only",
      revision: 1,
      commit: "b".repeat(40),
      branch: "fix",
      modes: ["commit"],
      createdAt: 1,
    },
    {
      id: "unpublished",
      revision: 1,
      commit: "c".repeat(40),
      branch: "wip",
      modes: [],
      createdAt: 1,
    },
  ])
  renderPanel()
  fireEvent.change(screen.getByLabelText(q.scopeLabel), { target: { value: "acceptance" } })
  const start = screen.getByRole("button", { name: q.start })
  expect(start).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: q.loadDeliveries }))
  const select = (await screen.findByLabelText(q.delivery)) as HTMLSelectElement
  expect(Array.from(select.options).map((option) => option.value)).toEqual([
    "",
    "both",
    "commit-only",
  ])
  fireEvent.change(select, { target: { value: "both" } })
  fireEvent.change(screen.getByLabelText(q.script), { target: { value: "test && rm" } })
  expect(screen.getByText(q.scriptInvalid)).toBeInTheDocument()
  expect(start).toBeDisabled()
  fireEvent.change(screen.getByLabelText(q.script), { target: { value: "test:e2e" } })
  expect(start).toBeEnabled()
  fireEvent.click(start)
  await waitFor(() =>
    expect(api.qualifyStart).toHaveBeenCalledWith(target, {
      providerConfigId: "byo",
      scope: "acceptance",
      handoff: { deliveryId: "both", script: "test:e2e" },
    })
  )
})

test("says so when no delivery can be handed off", async () => {
  deliveries.mockResolvedValue([])
  renderPanel()
  fireEvent.change(screen.getByLabelText(q.scopeLabel), { target: { value: "acceptance" } })
  fireEvent.click(screen.getByRole("button", { name: q.loadDeliveries }))
  expect(await screen.findByText(q.noDeliveries)).toBeInTheDocument()
})

test("nothing can start without a stored provider key", () => {
  renderPanel([], { config: { ...config, credentialPresent: false } })
  expect(screen.getByRole("button", { name: q.start })).toBeDisabled()
  expect(screen.getByText(messages.configForm.credentialMissing)).toBeInTheDocument()
})

test("a paused run shows its exact quote and approves only that quote", async () => {
  renderPanel([
    run({
      state: "awaitingApproval",
      awaitingApproval: { quote, purpose: "prepareTemplate", templateBuildCharges: true },
    }),
  ])
  expect(screen.queryByRole("button", { name: q.start })).toBeNull()
  const step = screen.getByRole("group", { name: q.awaitingTitle })
  expect(step).toHaveTextContent(q.purpose.prepareTemplate)
  expect(step).toHaveTextContent("USD 0.1656/hour")
  expect(step).toHaveTextContent("USD 0.0055")
  expect(document.querySelector("[data-disclosure='template-build']")).toHaveTextContent(
    q.templateBuildCharges
  )
  fireEvent.click(screen.getByRole("button", { name: q.approve }))
  await waitFor(() => expect(api.qualifyApprove).toHaveBeenCalledWith(target, "run-1", "quote-1"))
})

test("a smoke step does not claim template build charges", () => {
  renderPanel([
    run({
      state: "awaitingApproval",
      awaitingApproval: { quote, purpose: "smoke", templateBuildCharges: false },
    }),
  ])
  expect(document.querySelector("[data-disclosure='template-build']")).toBeNull()
})

test("cancelling asks first and then stops the run", async () => {
  renderPanel([run()])
  expect(screen.getByRole("status")).toHaveTextContent(
    `${q.runState.running} · Now: ${q.category.lifecycle}`
  )
  confirm.mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole("button", { name: q.cancel }))
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }))
  )
  expect(api.qualifyCancel).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: q.cancel }))
  await waitFor(() => expect(api.qualifyCancel).toHaveBeenCalledWith(target, "run-1"))
})

test("earlier runs show their outcome, including a Host restart", () => {
  renderPanel([
    run({ runId: "b", state: "interrupted", finishedAt: 2 }),
    run({ runId: "a", state: "failed", errorCode: "managed_desktop_policy_limit", finishedAt: 1 }),
  ])
  const rows = document.querySelectorAll("[data-run-state]")
  expect(rows[0]).toHaveTextContent(q.runState.interrupted)
  expect(rows[1]).toHaveTextContent(messages.errors.policyLimit)
  expect(screen.getByRole("button", { name: q.start })).toBeEnabled()
})

test("shows the Host's refusal in the active locale", async () => {
  api.qualifyStart.mockRejectedValue(new Error("managed_desktop_qualification_running"))
  renderPanel([], {}, zhMessages)
  fireEvent.click(screen.getByRole("button", { name: zhMessages.qualification.start }))
  expect(await screen.findByRole("alert")).toHaveTextContent(zhMessages.errors.qualificationRunning)
})
