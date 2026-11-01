/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import zh from "@/i18n/messages/zh-CN/plugins/auth.json"
import { ConnectionAddScopesDialog } from "./connection-add-scopes-dialog"

it("explains additional access and wires reconnect, decline, close and Escape", async () => {
  const onReconnect = jest.fn(),
    onDecline = jest.fn(),
    onDismiss = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <ConnectionAddScopesDialog
        pluginName="Calendar"
        accountLabel="Person"
        scopes={["events.write"]}
        onReconnect={onReconnect}
        onDecline={onDecline}
        onDismiss={onDismiss}
      />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("dialog", { name: "Additional access for Calendar" })).toHaveTextContent(
    "events.write"
  )
  expect(screen.getByRole("dialog")).toHaveTextContent("Reconnect Person")
  await userEvent.click(screen.getByRole("button", { name: "Reconnect" }))
  await userEvent.click(screen.getByRole("button", { name: "Decline" }))
  await userEvent.click(screen.getByRole("button", { name: "Close" }))
  await userEvent.keyboard("{Escape}")
  expect(onReconnect).toHaveBeenCalledTimes(1)
  expect(onDecline).toHaveBeenCalledTimes(1)
  expect(onDismiss).toHaveBeenCalledTimes(2)
})

it("has matching connection prompt keys in both locales", () => {
  expect(Object.keys(en.connections).sort()).toEqual(Object.keys(zh.connections).sort())
})
