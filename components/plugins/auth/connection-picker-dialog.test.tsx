/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import zh from "@/i18n/messages/zh-CN/plugins/auth.json"
import type { AuthConnectionMetadata } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { ConnectionPickerDialog } from "./connection-picker-dialog"

const connection: AuthConnectionMetadata = {
  ref: "ref" as AuthConnectionMetadata["ref"],
  providerId: "vendor",
  accountLabel: "Account",
  principalKind: "user",
  issuer: "https://issuer.test",
  tenantLabel: "Organization",
  scopes: ["read"],
  status: "connected",
  revision: 1,
}

it("shows the account, issuer, organization and scopes and selects the opaque ref", async () => {
  const onSelect = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <ConnectionPickerDialog
        pluginName="Calendar"
        candidates={[connection]}
        onSelect={onSelect}
        onDismiss={() => {}}
      />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("dialog", { name: "Choose an account for Calendar" })).toBeVisible()
  expect(screen.getByText("Organization: Organization")).toBeVisible()
  expect(screen.getByText("Available scopes: read")).toBeVisible()
  await userEvent.click(screen.getByRole("button", { name: "Use Account at https://issuer.test" }))
  expect(onSelect).toHaveBeenCalledWith("ref")
})

it("dismisses with Escape or the translated close button", async () => {
  const onDismiss = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <ConnectionPickerDialog
        pluginName="Calendar"
        candidates={[connection]}
        onSelect={() => {}}
        onDismiss={onDismiss}
      />
    </NextIntlClientProvider>
  )
  await userEvent.keyboard("{Escape}")
  await userEvent.click(screen.getByRole("button", { name: "Close" }))
  expect(onDismiss).toHaveBeenCalledTimes(2)
})

it("has every connection key in both locales", () => {
  expect(Object.keys(en.connections).sort()).toEqual(Object.keys(zh.connections).sort())
  for (const messages of [en, zh])
    expect(Object.values(messages.connections).every((value) => value.length > 0)).toBe(true)
})
