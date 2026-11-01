/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import zh from "@/i18n/messages/zh-CN/plugins/auth.json"
import { ConnectionSignInDialog } from "./connection-sign-in-dialog"

it("renders sign-in and dismissal using translated labels", async () => {
  const messages = en
  const onSignIn = jest.fn()
  const onDismiss = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: messages } }}>
      <ConnectionSignInDialog
        pluginName="Calendar"
        providerLabel="Acme"
        scopes={["calendar.read"]}
        onSignIn={onSignIn}
        onDismiss={onDismiss}
      />
    </NextIntlClientProvider>
  )
  expect(
    screen.getByRole("dialog", {
      name: messages.connections.signInTitle.replace("{provider}", "Acme"),
    })
  ).toBeVisible()
  expect(screen.getByText("calendar.read")).toBeVisible()
  await userEvent.click(screen.getByRole("button", { name: messages.connections.signIn }))
  expect(onSignIn).toHaveBeenCalledTimes(1)
  await userEvent.keyboard("{Escape}")
  await userEvent.click(screen.getByRole("button", { name: messages.connections.dismiss }))
  expect(onDismiss).toHaveBeenCalledTimes(2)
})

it("provides all sign-in keys in both locales", () => {
  for (const key of ["signInTitle", "signInDescription", "signIn"] as const) {
    expect(en.connections[key]).toBeTruthy()
    expect(zh.connections[key]).toBeTruthy()
  }
})
