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
// jsdom cannot drive the desktop Radix picker; the HTML select API is what the form uses.
jest.mock("@/components/ui/native-select", () => ({
  NativeSelect: (props: React.ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: React.ComponentProps<"option">) => <option {...props} />,
}))
const confirm = jest.fn()
jest.mock("@/components/shared/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm, dialog: null }),
}))
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  managedDesktopClient: {
    saveConfig: jest.fn(),
    deleteConfig: jest.fn(),
    setCredential: jest.fn(),
    rotateCredential: jest.fn(),
  },
  managedDesktopErrorKey: jest.fn(() => "configRevisionConflict"),
}))
jest.mock("@/lib/sandbox/remote-sandboxes-client", () => ({
  remoteSandboxesGet: jest.fn(),
  providerCredentialSecretId: (provider: { credential?: { secretId?: string } }) =>
    provider.credential?.secretId,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
import zhMessages from "@/i18n/messages/zh-CN/settings/managedDesktops.json"
import {
  managedDesktopClient,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"
import { remoteSandboxesGet } from "@/lib/sandbox/remote-sandboxes-client"
import { ManagedDesktopConfigForm, managedDesktopDraft } from "./managed-desktop-config-form"

const api = managedDesktopClient as jest.Mocked<typeof managedDesktopClient>
const form = messages.configForm
const DAY = 24 * 60 * 60 * 1000

const config: ManagedDesktopConfigSummary = {
  id: "byo",
  ownerPrincipalId: "owner",
  hostId: "host",
  revision: 3,
  credentialGeneration: 1,
  credentialPresent: false,
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
  isolationMinimum: "vm",
  enabled: true,
  qualification: "unqualified",
  canPrepareTemplate: false,
  canCreate: false,
  isolationTier: "vm",
  egressTier: "off",
  egressEnforcement: "unverified",
  maxConcurrent: 2,
  maxLifetimeSeconds: 3600,
  idleTimeoutSeconds: 600,
  cpuCount: 2,
  memoryMb: 4096,
  enablement: { manualGui: false, agentControl: false, acceptance: false },
  qualificationCategories: (
    ["lifecycle", "control", "authority", "workload", "commit", "bundle"] as const
  ).map((category) => ({ category, current: false, observedAt: null })),
}
/** The four GUI receipts current; neither handoff receipt. */
const guiQualified: ManagedDesktopConfigSummary = {
  ...config,
  qualificationCategories: config.qualificationCategories.map((receipt) => ({
    ...receipt,
    current: !["commit", "bundle"].includes(receipt.category),
    observedAt: ["commit", "bundle"].includes(receipt.category) ? null : 1,
  })),
}

function renderForm(
  props: Partial<Parameters<typeof ManagedDesktopConfigForm>[0]> = {},
  locale: typeof messages = messages
) {
  const onSaved = jest.fn()
  const onDeleted = jest.fn()
  const target: ManagedDesktopTarget = props.target ?? { kind: "remote", hostId: "host" }
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: locale } }}>
      <ManagedDesktopConfigForm
        target={target}
        onSaved={onSaved}
        onDeleted={onDeleted}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { onSaved, onDeleted }
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

beforeEach(() => {
  jest.clearAllMocks()
  confirm.mockResolvedValue(true)
  ;(remoteSandboxesGet as jest.Mock).mockResolvedValue({
    settings: { providers: { providers: [] } },
    storedSecretIds: [],
  })
})

describe("managedDesktopDraft", () => {
  const valid = {
    id: "byo",
    enabled: true,
    cpuCount: "2",
    memoryMb: "4096",
    maxConcurrent: "2",
    maxLifetimeSeconds: "3600",
    idleTimeoutSeconds: "600",
    planMaxLifetimeSeconds: "3600",
    planSource: "billing page",
    planNamespace: "team",
    planValidDays: "7",
    priceHourly: "0.1656",
    priceCurrency: "usd",
    priceSource: "pricing page",
    priceValidDays: "30",
    planValidForMs: null,
    priceValidForMs: null,
    isolationMinimum: "vm" as const,
    manualGui: true,
    agentControl: false,
    acceptance: false,
  }

  test("sends durations and micros, never timestamps or owner fields", () => {
    const result = managedDesktopDraft(valid, 3)
    expect(result).toEqual({
      draft: {
        id: "byo",
        expectedRevision: 3,
        enabled: true,
        shape: { cpuCount: 2, memoryMb: 4096 },
        limits: { maxConcurrent: 2, maxLifetimeSeconds: 3600, idleTimeoutSeconds: 600 },
        plan: {
          maxLifetimeSeconds: 3600,
          source: "billing page",
          namespace: "team",
          validForMs: 7 * DAY,
        },
        price: {
          currency: "USD",
          hourlyRateMicros: 165_600,
          source: "pricing page",
          validForMs: 30 * DAY,
        },
        egress: { mode: "off" },
        isolationMinimum: "vm",
        enablement: { manualGui: true, agentControl: false, acceptance: false },
      },
    })
  })

  test.each([
    ["id", "has space"],
    ["maxConcurrent", "3"],
    ["maxLifetimeSeconds", "3601"],
    ["idleTimeoutSeconds", "601"],
    ["planMaxLifetimeSeconds", "86401"],
    ["planValidDays", "31"],
    ["priceHourly", "0"],
    ["priceHourly", "0.1234567"],
    ["priceCurrency", "dollars"],
    ["priceSource", " "],
  ] as const)("refuses %s=%p instead of clipping it", (field, value) => {
    expect(managedDesktopDraft({ ...valid, [field]: value }, null)).toEqual({ invalid: field })
  })
})

test("creates a configuration with no expected revision", async () => {
  api.saveConfig.mockResolvedValue({ ...config, id: "fresh", revision: 1 })
  const { onSaved } = renderForm()
  fill(form.fields.id, "fresh")
  fill(form.fields.planSource, "billing page")
  fill(form.fields.planNamespace, "team")
  fill(form.fields.priceHourly, "0.1656")
  fill(form.fields.priceSource, "pricing page")
  fireEvent.click(screen.getByRole("button", { name: form.create }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(api.saveConfig).toHaveBeenCalledWith(
    { kind: "remote", hostId: "host" },
    expect.objectContaining({ id: "fresh", expectedRevision: null, egress: { mode: "off" } })
  )
  expect(screen.queryByRole("region", { name: form.credentialTitle })).toBeNull()
})

test("points at the first invalid field without calling the Host", () => {
  renderForm()
  fill(form.fields.id, "fresh")
  fireEvent.click(screen.getByRole("button", { name: form.create }))
  expect(screen.getByRole("alert")).toHaveTextContent(form.fields.planSource)
  expect(screen.getByLabelText(form.fields.planSource)).toHaveAttribute("aria-invalid", "true")
  expect(api.saveConfig).not.toHaveBeenCalled()
})

test("edits with the current revision and keeps the ID fixed", async () => {
  api.saveConfig.mockResolvedValue({ ...config, revision: 4 })
  const { onSaved } = renderForm({ config })
  expect(screen.getByLabelText(form.fields.id)).toBeDisabled()
  fill(form.fields.cpuCount, "4")
  fireEvent.click(screen.getByRole("button", { name: form.save }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...config, revision: 4 }))
  expect(api.saveConfig.mock.calls[0][1]).toMatchObject({
    expectedRevision: 3,
    shape: { cpuCount: 4, memoryMb: 4096 },
  })
})

test("stores the first key write-only and clears the field", async () => {
  api.setCredential.mockResolvedValue({ ...config, credentialPresent: true })
  const { onSaved } = renderForm({ config })
  expect(screen.getByText(form.credentialMissing)).toBeInTheDocument()
  fill(form.fields.key, "e2b_secret")
  fireEvent.click(screen.getByRole("button", { name: form.storeKey }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(api.setCredential).toHaveBeenCalledWith({ kind: "remote", hostId: "host" }, "byo", 3, {
    kind: "key",
    key: "e2b_secret",
  })
  expect(confirm).not.toHaveBeenCalled()
  expect(screen.getByLabelText(form.fields.key)).toHaveValue("")
})

test("replacing a stored key asks first and rotates", async () => {
  api.rotateCredential.mockResolvedValue({ ...config, credentialGeneration: 2 })
  renderForm({ config: { ...config, credentialPresent: true } })
  expect(screen.getByText("Key stored (generation 1)")).toBeInTheDocument()
  fill(form.fields.key, "e2b_next")
  confirm.mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole("button", { name: form.rotate }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
  expect(api.rotateCredential).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: form.rotate }))
  await waitFor(() => expect(api.rotateCredential).toHaveBeenCalled())
  expect(api.setCredential).not.toHaveBeenCalled()
})

test("copies a stored code-sandbox key on this desktop only", async () => {
  ;(remoteSandboxesGet as jest.Mock).mockResolvedValue({
    settings: {
      providers: {
        providers: [
          {
            id: "e2b-main",
            kind: "e2b",
            label: "Main",
            credential: { secretId: "remote-sandbox:e2b-main" },
          },
          { id: "e2b-env", kind: "e2b", credential: { env: "E2B_API_KEY" } },
          { id: "k8s", kind: "kubernetes", credential: { secretId: "remote-sandbox:k8s" } },
          { id: "e2b-empty", kind: "e2b", credential: { secretId: "remote-sandbox:e2b-empty" } },
        ],
      },
    },
    storedSecretIds: ["remote-sandbox:e2b-main", "remote-sandbox:k8s"],
  })
  api.setCredential.mockResolvedValue({ ...config, credentialPresent: true })
  renderForm({ config, target: { kind: "local" } })
  const select = await screen.findByLabelText(form.fields.copyFrom)
  expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
    "",
    "e2b-main",
  ])
  fireEvent.change(select, { target: { value: "e2b-main" } })
  fireEvent.click(screen.getByRole("button", { name: form.copyKey }))
  await waitFor(() =>
    expect(api.setCredential).toHaveBeenCalledWith({ kind: "local" }, "byo", 3, {
      kind: "remoteSandbox",
      providerId: "e2b-main",
    })
  )
})

test("a remote Host never offers this desktop's code-sandbox keys", async () => {
  renderForm({ config })
  await waitFor(() => expect(screen.getByText(form.credentialMissing)).toBeInTheDocument())
  expect(remoteSandboxesGet).not.toHaveBeenCalled()
  expect(screen.queryByLabelText(form.fields.copyFrom)).toBeNull()
})

test("deletes only after a destructive confirmation", async () => {
  api.deleteConfig.mockResolvedValue(null)
  const { onDeleted } = renderForm({ config })
  confirm.mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole("button", { name: form.delete }))
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }))
  )
  expect(api.deleteConfig).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: form.delete }))
  await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  expect(api.deleteConfig).toHaveBeenCalledWith({ kind: "remote", hostId: "host" }, "byo", 3)
})

test("shows the Host's refusal in the active locale", async () => {
  api.saveConfig.mockRejectedValue(new Error("managed_desktop_config_revision_conflict"))
  renderForm({ config }, zhMessages)
  fireEvent.click(screen.getByRole("button", { name: zhMessages.configForm.save }))
  expect(await screen.findByRole("alert")).toHaveTextContent(
    zhMessages.errors.configRevisionConflict
  )
})

describe("enablement switches", () => {
  test("a new or unqualified configuration cannot turn any switch on", () => {
    renderForm({ config })
    for (const gate of ["manualGui", "agentControl", "acceptance"] as const)
      expect(screen.getByLabelText(form.fields[gate])).toBeDisabled()
    expect(document.querySelector("[data-gate-missing='manualGui']")).toHaveTextContent(
      "Lifecycle, Control, Authority, Workload isolation"
    )
    expect(document.querySelector("[data-gate-missing='acceptance']")).toHaveTextContent(
      "Recovery bundle handoff"
    )
  })

  test("GUI receipts allow GUI and agent control without handoff receipts", async () => {
    api.saveConfig.mockResolvedValue(guiQualified)
    renderForm({ config: guiQualified })
    expect(screen.getByLabelText(form.fields.manualGui)).toBeEnabled()
    expect(screen.getByLabelText(form.fields.agentControl)).toBeEnabled()
    expect(screen.getByLabelText(form.fields.acceptance)).toBeDisabled()
    expect(document.querySelector("[data-gate-missing='acceptance']")).toHaveTextContent(
      `${messages.qualification.category.commit}, ${messages.qualification.category.bundle}`
    )
    fireEvent.click(screen.getByLabelText(form.fields.manualGui))
    fireEvent.click(screen.getByRole("button", { name: form.save }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    expect(api.saveConfig.mock.calls[0][1].enablement).toEqual({
      manualGui: true,
      agentControl: false,
      acceptance: false,
    })
  })

  test("a switch left on with stale receipts can still be turned off", async () => {
    api.saveConfig.mockResolvedValue(config)
    renderForm({
      config: {
        ...config,
        enablement: { manualGui: false, agentControl: true, acceptance: false },
      },
    })
    const agent = screen.getByLabelText(form.fields.agentControl)
    expect(agent).toBeEnabled()
    fireEvent.click(agent)
    expect(agent).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: form.save }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    expect(api.saveConfig.mock.calls[0][1].enablement.agentControl).toBe(false)
  })

  test("labels agent control as not yet reachable by chat agents", () => {
    renderForm({ config: guiQualified }, zhMessages)
    expect(
      document.querySelector("[data-dormant='managed-desktop-agent-delegation']")
    ).toHaveTextContent(zhMessages.configForm.agentControlDormant)
  })
})

describe("confirmation windows", () => {
  const stored = {
    ...config,
    plan: { ...config.plan, observedAt: 1_000, expiresAt: 1_000 + 600_000 },
    price: { ...config.price, observedAt: 1_000, expiresAt: 1_000 + 7 * DAY },
  }

  test("a save that keeps the day fields sends the stored windows exactly", async () => {
    api.saveConfig.mockResolvedValue(stored)
    renderForm({ config: stored })
    expect(screen.getByLabelText(form.fields.priceValidDays)).toHaveValue("7")
    fireEvent.click(screen.getByRole("button", { name: form.save }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    const draft = api.saveConfig.mock.calls[0][1]
    expect(draft.plan.validForMs).toBe(600_000)
    expect(draft.price.validForMs).toBe(7 * DAY)
  })

  test("editing a day field confirms a new whole-day window", async () => {
    api.saveConfig.mockResolvedValue(stored)
    renderForm({ config: stored })
    fill(form.fields.planValidDays, "3")
    fireEvent.click(screen.getByRole("button", { name: form.save }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    const draft = api.saveConfig.mock.calls[0][1]
    expect(draft.plan.validForMs).toBe(3 * DAY)
    expect(draft.price.validForMs).toBe(7 * DAY)
  })
})
