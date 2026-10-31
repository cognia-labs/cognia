/** @jest-environment jsdom */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import type { AuthConnectionMetadata } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { ConnectionGrantDialog } from "./connection-grant-dialog"

const connection: AuthConnectionMetadata = {
  ref: "ref" as AuthConnectionMetadata["ref"],
  providerId: "vendor",
  accountLabel: "Account",
  principalKind: "user",
  issuer: "https://issuer.test",
  tenantLabel: "Organization",
  scopes: ["read", "write"],
  status: "connected",
  revision: 1,
}

it("names the consumer and account and groups reads and writes with scopes", async () => {
  const onApprove = jest.fn(),
    onDecline = jest.fn(),
    onDismiss = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <ConnectionGrantDialog
        pluginName="Calendar"
        connection={connection}
        scopes={["read"]}
        operations={[
          { id: "calendar.list", label: "List events", integrationLabel: "Calendar", risk: "read" },
          {
            id: "calendar.remove",
            label: "Remove event",
            integrationLabel: "Calendar",
            risk: "destructive",
          },
        ]}
        onApprove={onApprove}
        onDecline={onDecline}
        onDismiss={onDismiss}
      />
    </NextIntlClientProvider>
  )
  expect(
    screen.getByRole("dialog", { name: "Allow Calendar to use this connection?" })
  ).toBeVisible()
  expect(screen.getByText("Account")).toBeVisible()
  expect(screen.getByText("https://issuer.test")).toBeVisible()
  expect(screen.getByText("Organization")).toBeVisible()
  expect(
    within(screen.getByRole("region", { name: "Read operations" })).getByText("calendar.list")
  ).toBeVisible()
  expect(
    within(screen.getByRole("region", { name: "Write operations" })).getByText("Destructive")
  ).toBeVisible()
  expect(
    within(screen.getByRole("region", { name: "Requested scopes" })).getByText("read")
  ).toBeVisible()
  await userEvent.click(screen.getByRole("button", { name: "Allow access" }))
  await userEvent.click(screen.getByRole("button", { name: "Decline" }))
  await userEvent.click(screen.getByRole("button", { name: "Close" }))
  await userEvent.keyboard("{Escape}")
  expect(onApprove).toHaveBeenCalledTimes(1)
  expect(onDecline).toHaveBeenCalledTimes(1)
  expect(onDismiss).toHaveBeenCalledTimes(2)
})
