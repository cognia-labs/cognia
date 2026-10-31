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
import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/managedAcceptance.json"
import zh from "@/i18n/messages/zh-CN/managedAcceptance.json"
import { ManagedDesktopAcceptanceCriteria } from "./managed-desktop-acceptance-criteria"

function Editor({ count = 1 }: { count?: number }) {
  const [value, setValue] = useState(
    Array.from({ length: count }, () => ({ description: "", screenshotRequired: false }))
  )
  return <ManagedDesktopAcceptanceCriteria value={value} onChange={setValue} />
}
test.each([
  ["en", en],
  ["zh-CN", zh],
] as const)(
  "shared controls: %s screenshot checkbox supports its label and Space",
  async (locale, messages) => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale={locale} messages={{ managedAcceptance: messages }}>
        <Editor />
      </NextIntlClientProvider>
    )
    const label = messages.criteria.screenshot.replace("{number}", "1")
    const checkbox = screen.getByRole("checkbox", { name: label })
    expect(checkbox).toHaveAttribute("data-slot", "checkbox")
    await user.click(screen.getByText(label))
    expect(checkbox).toBeChecked()
    checkbox.focus()
    await user.keyboard(" ")
    expect(checkbox).not.toBeChecked()
    expect(screen.getByRole("textbox")).toHaveValue("")
  }
)
test.each([
  ["en", en],
  ["zh-CN", zh],
] as const)(
  "%s editor adds/removes rows and preserves screenshot requirements",
  (locale, messages) => {
    render(
      <NextIntlClientProvider locale={locale} messages={{ managedAcceptance: messages }}>
        <Editor />
      </NextIntlClientProvider>
    )
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Visible" } })
    fireEvent.click(screen.getByRole("checkbox"))
    expect(screen.getByRole("checkbox")).toBeChecked()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: messages.criteria.add }))
    expect(screen.getAllByRole("textbox")).toHaveLength(2)
    fireEvent.click(
      screen.getByRole("button", { name: messages.criteria.remove.replace("{number}", "2") })
    )
    expect(screen.getByRole("textbox")).toHaveValue("Visible")
    expect(screen.getByRole("checkbox")).toBeChecked()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "中".repeat(342) } })
    expect(screen.getByRole("alert")).toHaveTextContent(messages.criteria.invalid)
  }
)
test("the editor caps rows at fifty and removing the last row is visibly invalid", () => {
  const view = render(
    <NextIntlClientProvider locale="en" messages={{ managedAcceptance: en }}>
      <Editor count={50} />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("button", { name: en.criteria.add })).toBeDisabled()
  view.unmount()
  render(
    <NextIntlClientProvider locale="en" messages={{ managedAcceptance: en }}>
      <Editor />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 1" }))
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  expect(screen.getByRole("alert")).toBeVisible()
})
