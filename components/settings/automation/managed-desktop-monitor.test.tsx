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
    useFormatter: () => ({
      number: (value: number, options: { currency: string }) => `${options.currency} ${value}`,
      dateTime: (value: Date) => value.toISOString(),
    }),
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
          .replace(/\{count, plural,.*\}$/s, String(values?.count))
          .replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`))
      }
    },
  }
})
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  watchManagedDesktopMonitor: jest.fn(),
}))
import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
import zhMessages from "@/i18n/messages/zh-CN/settings/managedDesktops.json"
import {
  watchManagedDesktopMonitor,
  type ManagedDesktopMonitor,
} from "@/lib/automation/managed-desktop-client"
import { ManagedDesktopMonitorPanel } from "./managed-desktop-monitor"

const watch = watchManagedDesktopMonitor as jest.Mock
const monitor: ManagedDesktopMonitor = {
  observedAt: 10,
  billedDesktops: 2,
  maximumExposureMicros: { USD: 170_000 },
  oldestPendingCreateAt: null,
  oldestPendingDeleteAt: Date.UTC(2026, 9, 29, 3, 0, 0),
  alerts: [{ kind: "pastDeadline", subjectId: "desk-9", providerConfigId: "byo", since: 1 }],
}

function renderPanel(locale = messages) {
  const stop = jest.fn()
  watch.mockReturnValue(stop)
  const view = render(
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: locale } }}>
      <ManagedDesktopMonitorPanel target={{ kind: "remote", hostId: "host" }} />
    </NextIntlClientProvider>
  )
  const push = (value: ManagedDesktopMonitor) => act(() => watch.mock.calls[0][1](value))
  return { ...view, stop, push }
}

beforeEach(() => jest.clearAllMocks())

test("renders nothing until the Host answered, then billing, pending cleanup and alerts", () => {
  const { container, push } = renderPanel()
  expect(container).toBeEmptyDOMElement()
  expect(watch).toHaveBeenCalledWith({ kind: "remote", hostId: "host" }, expect.any(Function))
  push(monitor)
  expect(screen.getByRole("region", { name: messages.monitor.title })).toHaveAttribute(
    "data-billed",
    "2"
  )
  expect(screen.getByText("At most USD 0.17 of remaining compute")).toBeInTheDocument()
  expect(screen.getByText(/Oldest pending cleanup: 2026-10-29T03:00:00/)).toBeInTheDocument()
  expect(screen.queryByText(/Oldest pending create/)).toBeNull()
  expect(screen.getByRole("alert")).toHaveTextContent("Desktop desk-9 is past its hard deadline.")
})

test("stops watching on unmount", () => {
  const { unmount, stop } = renderPanel()
  unmount()
  expect(stop).toHaveBeenCalled()
})

test("has Chinese copy", () => {
  const { push } = renderPanel(zhMessages)
  push({ ...monitor, alerts: [] })
  expect(screen.getByRole("region", { name: zhMessages.monitor.title })).toBeInTheDocument()
  expect(screen.queryByRole("alert")).toBeNull()
})
