/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/settings/externalServices.json"
import type { ConnectionView } from "@/lib/external-services/connection-view"
import { ConnectionRow } from "./connection-row"

it("shows metadata and grouped grant operations, and disables destructive actions while busy", async () => {
  const view: ConnectionView = {
    connection: {
      id: "host" as ConnectionView["connection"]["id"],
      providerId: "vendor",
      ownerPluginId: "owner",
      publisher: null,
      contractMajor: 1,
      clientId: "client",
      principalId: "person",
      credentialRevision: 1,
      lineageId: "lineage",
      identityKey: "identity",
      createdAt: 0,
      updatedAt: 0,
      accountLabel: "Person",
      issuer: "https://issuer.test",
      principalKind: "bot",
      status: "provider-unavailable",
      scopes: [],
      revision: 3,
    },
    providerLabel: "Vendor",
    canReconnect: true,
    consumers: [
      {
        pluginId: "business",
        name: "Business",
        grants: [
          {
            id: "g",
            revision: 3,
            needsReapproval: false,
            readOperations: ["items.list"],
            writeOperations: ["items.remove"],
          },
        ],
      },
    ],
  }
  const onReconnect = jest.fn(),
    onDisconnect = jest.fn(),
    onRevokeConsumer = jest.fn()
  const content = (busy: boolean, blocked = false) => (
    <NextIntlClientProvider locale="en" messages={{ settings: { externalServices: en } }}>
      <ConnectionRow
        view={view}
        busy={busy}
        runtimeSupport={
          blocked
            ? { availability: "blocked", reason: "confidential-exchange-unavailable", recovery: [] }
            : undefined
        }
        onReconnect={onReconnect}
        onDisconnect={onDisconnect}
        onRevokeConsumer={onRevokeConsumer}
      />
    </NextIntlClientProvider>
  )
  const { rerender } = render(content(false))
  expect(screen.getByText("Provider unavailable")).toBeVisible()
  expect(screen.getByText("Bot")).toBeVisible()
  expect(screen.getByText("Read operations")).toBeVisible()
  expect(screen.getByText("items.list")).toBeVisible()
  expect(screen.getByText("Write operations")).toBeVisible()
  expect(screen.getByText("items.remove")).toBeVisible()
  expect(screen.queryByText("Needs re-approval")).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Reconnect" }))
  expect(onReconnect).toHaveBeenCalledTimes(1)
  rerender(content(false, true))
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled()
  expect(screen.getByText("reasons.confidential-exchange-unavailable")).toBeVisible()
  rerender(content(true))
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Revoke access for Business" })).toBeDisabled()
})
