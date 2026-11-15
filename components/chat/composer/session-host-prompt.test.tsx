/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SessionHostPromptDialog } from "./session-host-prompt"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? `:${JSON.stringify(values)}` : ""}`,
}))
jest.mock("./session-host-target-chip", () => ({
  SessionHostTargetChip: ({ onRebound }: { onRebound: () => void }) => (
    <button onClick={onRebound}>Choose Host B</button>
  ),
}))
jest.mock("@/lib/devices/execution-host-guard", () => ({ anyRunActive: async () => true }))
const initial = useRemoteHostStore.getState()
const binding = { origin: { kind: "remote" as const, hostId: "a" }, workspaceRoot: "/repo" }
const host = (id: string, connectionState: RemoteHost["connectionState"] = "ready") =>
  ({
    id,
    label: `Host ${id.toUpperCase()}`,
    connectionState,
    capabilities: ["sidecar"],
    config: {},
    addedAt: 1,
  }) as RemoteHost
beforeEach(() =>
  useRemoteHostStore.setState(
    { ...initial, hosts: [host("a", "disconnected"), host("b")], activeHostId: "a" },
    true
  )
)
afterEach(() => useRemoteHostStore.setState(initial, true))

it("offers Wait, Cancel and an explicit other-Host choice without retrying elsewhere", async () => {
  const answer = jest.fn()
  const user = userEvent.setup()
  render(
    <SessionHostPromptDialog
      prompt={{ sessionId: "s", binding, decision: "host-unavailable" }}
      onAnswer={answer}
    />
  )
  expect(screen.getByRole("button", { name: "chat.composer.target.wait" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Choose Host B" })).toBeVisible()
  await user.click(screen.getByRole("button", { name: "chat.composer.target.cancel" }))
  expect(answer).toHaveBeenCalledWith(false)
})

it("Wait retries only when the bound Host is ready", async () => {
  const answer = jest.fn()
  const user = userEvent.setup()
  render(
    <SessionHostPromptDialog
      prompt={{ sessionId: "s", binding, decision: "host-unavailable" }}
      onAnswer={answer}
    />
  )
  await user.click(screen.getByRole("button", { name: "chat.composer.target.wait" }))
  act(() => useRemoteHostStore.setState({ activeHostId: "b" }))
  expect(answer).not.toHaveBeenCalled()
  act(() => useRemoteHostStore.setState({ activeHostId: "a", hosts: [host("a"), host("b")] }))
  await waitFor(() => expect(answer).toHaveBeenCalledWith(true))
})

it("offers the named bound Host and passes its switch through the in-flight confirmation", async () => {
  useRemoteHostStore.setState({ activeHostId: "b" })
  const answer = jest.fn()
  const user = userEvent.setup()
  render(
    <SessionHostPromptDialog
      prompt={{ sessionId: "s", binding, decision: "switch-required" }}
      onAnswer={answer}
    />
  )
  await user.click(screen.getByRole("button", { name: /chat.composer.target.switchTo.*Host A/ }))
  expect(await screen.findByRole("alertdialog")).toBeVisible()
  expect(answer).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "devices.executionHost.confirmCancel" }))
  expect(answer).not.toHaveBeenCalledWith(true)
})
