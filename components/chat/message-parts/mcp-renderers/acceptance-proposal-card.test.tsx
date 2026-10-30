// Read the new split messages directly; aggregate regeneration belongs to the orchestrator.
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
jest.mock("@/lib/automation/managed-desktop-acceptance-request", () => ({
  requestAcceptancePanel: jest.fn(),
}))
jest.mock("next/navigation", () => ({ useRouter: jest.fn() }))
jest.mock("@/lib/automation/managed-desktop-handoff-client", () => ({
  ...jest.requireActual("@/lib/automation/managed-desktop-handoff-client"),
  managedDesktopHandoffClient: { prepare: jest.fn(), acceptanceStart: jest.fn() },
}))
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { NextIntlClientProvider } from "next-intl"
import { useRouter } from "next/navigation"
import en from "@/i18n/messages/en/managedAcceptance.json"
import zh from "@/i18n/messages/zh-CN/managedAcceptance.json"
import { requestAcceptancePanel } from "@/lib/automation/managed-desktop-acceptance-request"
import { managedDesktopHandoffClient } from "@/lib/automation/managed-desktop-handoff-client"
import { deviceConsoleHref } from "@/lib/devices/device-console-href"
import { AcceptanceProposalCard } from "./acceptance-proposal-card"

const proposal = {
  delivery: { id: "delivery", branch: "branch", commit: "a".repeat(40) },
  criteria: [{ description: "Page loads", screenshotRequired: true }],
  estimate: { currency: "USD", hourlyRateMicros: 165600 },
}
const part = (output: unknown) =>
  ({
    type: "tool-propose_acceptance",
    toolCallId: "call",
    state: "output-available",
    input: {},
    output,
  }) as ToolUIPart
const push = jest.fn()
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useRouter).mockReturnValue({ push } as never)
})
test.each([
  ["en", en],
  ["zh-CN", zh],
] as const)(
  "%s card opens the real panel through a prefill and never writes an RPC",
  (locale, messages) => {
    render(
      <NextIntlClientProvider locale={locale} messages={{ managedAcceptance: messages }}>
        <AcceptanceProposalCard part={part(JSON.stringify({ ok: true, proposal }))} />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Page loads", { exact: false })).toBeVisible()
    expect(screen.getByText(messages.proposal.cost)).toBeVisible()
    expect(
      screen.getByText(messages.proposal.estimate.replace("{cost}", "USD 0.1656"))
    ).toBeVisible()
    expect(screen.getAllByRole("button")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: messages.proposal.open }))
    expect(requestAcceptancePanel).toHaveBeenCalledWith({
      deliveryId: "delivery",
      criteria: proposal.criteria,
    })
    expect(push).toHaveBeenCalledWith(deviceConsoleHref("local", "sandbox"))
    expect(managedDesktopHandoffClient.prepare).not.toHaveBeenCalled()
    expect(managedDesktopHandoffClient.acceptanceStart).not.toHaveBeenCalled()
  }
)
test.each([null, { ok: false }, { ok: true, proposal: { ...proposal, criteria: [] } }])(
  "invalid output %j falls back",
  (output) => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={{ managedAcceptance: en }}>
        <AcceptanceProposalCard part={part(output)} />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  }
)
test("identity failures use a translated error and do not navigate", () => {
  jest.mocked(requestAcceptancePanel).mockImplementationOnce(() => {
    throw new Error("private path")
  })
  render(
    <NextIntlClientProvider locale="en" messages={{ managedAcceptance: en }}>
      <AcceptanceProposalCard part={part({ ok: true, proposal })} />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: en.proposal.open }))
  expect(screen.getByRole("alert")).toHaveTextContent(en.proposal.openFailed)
  expect(push).not.toHaveBeenCalled()
})
