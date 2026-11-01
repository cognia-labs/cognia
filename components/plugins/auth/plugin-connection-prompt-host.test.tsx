/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import { requestConnectionPrompt } from "@/lib/plugin/auth/connection-prompts"
import type { AuthConnectionMetadata } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { PluginConnectionPromptHost } from "./plugin-connection-prompt-host"
import { startHostAuthCallbackListeners } from "@/lib/plugin/auth/callback-acceptor"

jest.mock("@/lib/plugin/auth/callback-acceptor", () => ({
  startHostAuthCallbackListeners: jest.fn(() => jest.fn()),
}))

it("starts Host callbacks at runtime mount and wires sign-in approval", async () => {
  const { unmount } = render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  expect(startHostAuthCallbackListeners).toHaveBeenCalled()
  const stop = jest.mocked(startHostAuthCallbackListeners).mock.results.at(-1)!.value
  let pending!: ReturnType<typeof requestConnectionPrompt>
  act(() => {
    pending = requestConnectionPrompt({
      kind: "sign-in",
      pluginId: "calendar",
      pluginName: "Calendar",
      providerId: "acme",
      providerLabel: "Acme",
      scopes: ["read"],
    })
  })
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
  await expect(pending).resolves.toEqual({ kind: "sign-in" })
  unmount()
  expect(stop).toHaveBeenCalledTimes(1)
})

const connection: AuthConnectionMetadata = {
  ref: "ref" as AuthConnectionMetadata["ref"],
  providerId: "vendor",
  accountLabel: "Account",
  principalKind: "user",
  issuer: "https://issuer.test",
  scopes: ["read"],
  status: "connected",
  revision: 1,
}
const grant = {
  kind: "grant" as const,
  pluginId: "consumer",
  pluginName: "Calendar",
  connection,
  operations: [
    { id: "calendar.list", label: "List", integrationLabel: "Calendar", risk: "read" as const },
  ],
  scopes: ["read"],
}

it.each([
  ["Reconnect", "reconnect"],
  ["Decline", "denied"],
  ["Close", "dismissed"],
] as const)("wires the add-scope %s decision", async (label, kind) => {
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  let pending!: ReturnType<typeof requestConnectionPrompt>
  act(() => {
    pending = requestConnectionPrompt({
      kind: "add-scopes",
      pluginId: "calendar",
      pluginName: "Calendar",
      connection,
      scopes: ["write"],
    })
  })
  await userEvent.click(screen.getByRole("button", { name: label }))
  await expect(pending).resolves.toEqual({ kind })
})

it("queues picker and grant prompts one at a time and wires every decision", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  let picker!: ReturnType<typeof requestConnectionPrompt>,
    approved!: ReturnType<typeof requestConnectionPrompt>,
    denied!: ReturnType<typeof requestConnectionPrompt>,
    dismissed!: ReturnType<typeof requestConnectionPrompt>
  act(() => {
    picker = requestConnectionPrompt({
      kind: "picker",
      pluginId: "consumer",
      pluginName: "Calendar",
      candidates: [connection],
    })
    approved = requestConnectionPrompt(grant)
    denied = requestConnectionPrompt(grant)
    dismissed = requestConnectionPrompt(grant)
  })
  expect(screen.getAllByRole("dialog")).toHaveLength(1)
  await userEvent.click(screen.getByRole("button", { name: "Use Account at https://issuer.test" }))
  await expect(picker).resolves.toEqual({ kind: "selected", ref: "ref" })
  await userEvent.click(screen.getByRole("button", { name: "Allow access" }))
  await expect(approved).resolves.toEqual({ kind: "approved" })
  await userEvent.click(screen.getByRole("button", { name: "Decline" }))
  await expect(denied).resolves.toEqual({ kind: "denied" })
  await userEvent.keyboard("{Escape}")
  await expect(dismissed).resolves.toEqual({ kind: "dismissed" })
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("unmounting dismisses both the current and queued request", async () => {
  const { unmount } = render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  let first!: ReturnType<typeof requestConnectionPrompt>,
    second!: ReturnType<typeof requestConnectionPrompt>
  act(() => {
    first = requestConnectionPrompt(grant)
    second = requestConnectionPrompt(grant)
  })
  unmount()
  await expect(first).resolves.toEqual({ kind: "dismissed" })
  await expect(second).resolves.toEqual({ kind: "dismissed" })
})
