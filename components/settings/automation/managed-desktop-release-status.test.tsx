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
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
import zhMessages from "@/i18n/messages/zh-CN/settings/managedDesktops.json"
import type { ManagedDesktopReleaseStatus } from "@/lib/automation/managed-desktop-client"
import { ManagedDesktopReleaseStatusLine } from "./managed-desktop-release-status"

const digest = `sha256:${"b".repeat(64)}`
const installed: ManagedDesktopReleaseStatus = {
  state: "installed",
  source: "bundled",
  imageDigest: digest,
  recipeRevision: "7",
  protocol: "computer-server-0.3.46",
  error: null,
}

function renderStatus(status: ManagedDesktopReleaseStatus | null, locale = messages) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: locale } }}>
      <ManagedDesktopReleaseStatusLine status={status} />
    </NextIntlClientProvider>
  )
}

test("names the bundled source, recipe and digest of an installed release", () => {
  const { container } = renderStatus(installed)
  expect(screen.getByText(messages.release.sourceBundled)).toBeInTheDocument()
  expect(screen.getByText(digest)).toBeInTheDocument()
  expect(container.textContent).toContain("7")
  expect(container.textContent).toContain("computer-server-0.3.46")
  expect(container.querySelector("[data-release-state='installed']")).not.toBeNull()
})

test("distinguishes an operator-placed release from the bundled one", () => {
  renderStatus({ ...installed, source: "data-directory" })
  expect(screen.getByText(messages.release.sourceDataDirectory)).toBeInTheDocument()
  expect(screen.queryByText(messages.release.sourceBundled)).toBeNull()
})

test("explains that an absent release keeps provisioning dormant", () => {
  renderStatus({ ...installed, state: "absent", source: null, imageDigest: null })
  expect(screen.getByText(messages.release.absent)).toBeInTheDocument()
  expect(screen.queryByRole("alert")).toBeNull()
})

test("alerts on an invalid release without showing a fallback source", () => {
  renderStatus({
    state: "invalid",
    source: null,
    imageDigest: null,
    recipeRevision: null,
    protocol: null,
    error: "managed_desktop_release_mismatch",
  })
  expect(screen.getByRole("alert")).toHaveTextContent(messages.release.invalid)
  expect(screen.queryByText(messages.release.sourceBundled)).toBeNull()
})

test("renders nothing before the Host answered", () => {
  const { container } = renderStatus(null)
  expect(container).toBeEmptyDOMElement()
})

test("has Chinese copy for every state", () => {
  renderStatus(installed, zhMessages)
  expect(screen.getByText(zhMessages.release.sourceBundled)).toBeInTheDocument()
})
