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
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
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
        return result
          .replace(/\{count, plural,.*\}$/s, `in use ${values?.count}`)
          .replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`))
      }
    },
  }
})
const confirm = jest.fn()
jest.mock("@/components/shared/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm, dialog: null }),
}))
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  managedDesktopClient: { templateList: jest.fn(), templateDelete: jest.fn() },
  managedDesktopErrorKey: jest.fn(() => "templateInUse"),
}))
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
import {
  managedDesktopClient,
  type ManagedDesktopTemplateSummary,
} from "@/lib/automation/managed-desktop-client"
import { ManagedDesktopTemplates } from "./managed-desktop-templates"

const api = managedDesktopClient as jest.Mocked<typeof managedDesktopClient>
const template: ManagedDesktopTemplateSummary = {
  id: "op-1",
  providerConfigId: "byo",
  state: "ready",
  identity: {
    templateId: "tmpl-1",
    buildId: "b",
    imageDigest: "sha256:x",
    recipeRevision: "7",
    protocol: "p",
  },
  desktopsInUse: 0,
  createdAt: 1,
  updatedAt: 1,
  errorCode: null,
  cleanupAttempts: 0,
  nextRetryAt: null,
}

function renderTemplates(revision = 0) {
  const onChanged = jest.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: messages } }}>
      <ManagedDesktopTemplates
        target={{ kind: "local" }}
        revision={revision}
        onChanged={onChanged}
      />
    </NextIntlClientProvider>
  )
  return { ...view, onChanged }
}

beforeEach(() => {
  jest.clearAllMocks()
  confirm.mockResolvedValue(true)
})

test("lists templates and blocks deletion while desktops use one", async () => {
  api.templateList.mockResolvedValue([{ ...template, desktopsInUse: 2 }])
  renderTemplates()
  expect(await screen.findByText("tmpl-1")).toBeInTheDocument()
  expect(screen.getByText("in use 2")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: messages.templates.delete })).toBeDisabled()
})

test("deletes after a destructive confirmation and reports confirmed absence", async () => {
  api.templateList.mockResolvedValue([template])
  api.templateDelete.mockResolvedValue(null)
  const { onChanged } = renderTemplates()
  fireEvent.click(await screen.findByRole("button", { name: messages.templates.delete }))
  await waitFor(() => expect(onChanged).toHaveBeenCalled())
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }))
  expect(api.templateDelete).toHaveBeenCalledWith({ kind: "local" }, "op-1")
  expect(screen.getByRole("status")).toHaveTextContent("Template op-1 was deleted.")
})

test("a declined confirmation deletes nothing", async () => {
  api.templateList.mockResolvedValue([template])
  confirm.mockResolvedValueOnce(false)
  renderTemplates()
  fireEvent.click(await screen.findByRole("button", { name: messages.templates.delete }))
  await waitFor(() => expect(confirm).toHaveBeenCalled())
  expect(api.templateDelete).not.toHaveBeenCalled()
})

test("a pending deletion shows its retry instead of a delete button", async () => {
  api.templateList.mockResolvedValue([
    { ...template, state: "deleting", cleanupAttempts: 3, nextRetryAt: Date.UTC(2026, 9, 29) },
  ])
  renderTemplates()
  expect(await screen.findByText(messages.templates.deleting)).toBeInTheDocument()
  expect(screen.getByText(/Attempt 3; next retry 2026-10-29T00:00:00/)).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: messages.templates.delete })).toBeNull()
})

test("reloads when the settings revision changes and shows Host refusals", async () => {
  api.templateList.mockResolvedValue([template])
  const { rerender } = renderTemplates(0)
  await screen.findByText("tmpl-1")
  api.templateList.mockRejectedValueOnce(new Error("managed_desktop_template_in_use"))
  rerender(
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: messages } }}>
      <ManagedDesktopTemplates target={{ kind: "local" }} revision={1} onChanged={jest.fn()} />
    </NextIntlClientProvider>
  )
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.errors.templateInUse)
  expect(api.templateList).toHaveBeenCalledTimes(2)
})
