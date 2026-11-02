/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { StrictMode } from "react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import zh from "@/i18n/messages/zh-CN/plugins/auth.json"
import type { HostDeviceAuthorization } from "@/lib/plugin/auth/connection-manager"
import { openUrl } from "@/lib/native/opener"
import { DeviceAuthorizationDialog } from "./device-authorization-dialog"

jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn(async () => {}) }))

let authorization: HostDeviceAuthorization
let onClose: jest.Mock
let onAuthorized: jest.Mock
beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  authorization = {
    kind: "device-code",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://vendor.test/device",
    expiresAt: Date.now() + 60_000,
    intervalSeconds: 5,
    poll: jest.fn(async () => ({ status: "pending" as const })),
    cancel: jest.fn(async () => {}),
  }
  onClose = jest.fn()
  onAuthorized = jest.fn()
})
afterEach(() => jest.useRealTimers())
function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <DeviceAuthorizationDialog
        authorization={authorization}
        onClose={onClose}
        onAuthorized={onAuthorized}
      />
    </NextIntlClientProvider>
  )
}
async function tick(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

it("shows a copyable code and opens the verification link through openUrl", async () => {
  const writeText = jest.fn(async () => {})
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  mount()
  expect(screen.getByRole("dialog", { name: en.deviceTitle })).toBeVisible()
  expect(screen.getByText("ABCD-EFGH")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: en.deviceCopy }))
  await act(async () => {})
  expect(writeText).toHaveBeenCalledWith("ABCD-EFGH")
  expect(screen.getByRole("button", { name: en.deviceCopied })).toBeVisible()
  fireEvent.click(screen.getByRole("link", { name: authorization.verificationUrl }))
  expect(openUrl).toHaveBeenCalledWith(authorization.verificationUrl)
})
it("polls serially on returned intervals, honors slow_down and stops on authorization", async () => {
  jest
    .mocked(authorization.poll)
    .mockResolvedValueOnce({ status: "pending", intervalSeconds: 5 })
    .mockResolvedValueOnce({ status: "slow_down", intervalSeconds: 10 })
    .mockResolvedValueOnce({ status: "authorized" })
  mount()
  await tick(4999)
  expect(authorization.poll).not.toHaveBeenCalled()
  await tick(1)
  expect(authorization.poll).toHaveBeenCalledTimes(1)
  await tick(5000)
  expect(authorization.poll).toHaveBeenCalledTimes(2)
  await tick(9999)
  expect(authorization.poll).toHaveBeenCalledTimes(2)
  await tick(1)
  expect(onAuthorized).toHaveBeenCalledTimes(1)
  expect(onClose).toHaveBeenCalledTimes(1)
  await tick(30_000)
  expect(authorization.poll).toHaveBeenCalledTimes(3)
})
it.each(["denied", "expired"] as const)("stops polling and reports %s", async (status) => {
  jest.mocked(authorization.poll).mockResolvedValue({ status })
  mount()
  await tick(5000)
  expect(screen.getByRole("alert")).toHaveTextContent(
    status === "denied" ? en.deviceDenied : en.deviceExpired
  )
  await tick(30_000)
  expect(authorization.poll).toHaveBeenCalledTimes(1)
  expect(onAuthorized).not.toHaveBeenCalled()
  expect(authorization.cancel).toHaveBeenCalledTimes(1)
})
it("expires without another poll while a request is still pending", async () => {
  authorization.expiresAt = Date.now() + 7000
  let finish!: (result: { status: "authorized" }) => void
  jest.mocked(authorization.poll).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  mount()
  await tick(7000)
  expect(screen.getByRole("alert")).toHaveTextContent(en.deviceExpired)
  await act(async () => {
    finish({ status: "authorized" })
  })
  expect(onAuthorized).not.toHaveBeenCalled()
  expect(authorization.poll).toHaveBeenCalledTimes(1)
  expect(authorization.cancel).toHaveBeenCalledTimes(1)
})
it.each(["close", "unmount"])(
  "cancels on %s and ignores a late successful poll without concurrent polling",
  async (action) => {
    let finish!: (result: { status: "authorized" }) => void
    jest.mocked(authorization.poll).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = mount()
    await tick(20_000)
    expect(authorization.poll).toHaveBeenCalledTimes(1)
    if (action === "unmount") view.unmount()
    else fireEvent.click(screen.getByRole("button", { name: en.deviceCancel }))
    await act(async () => {
      finish({ status: "authorized" })
    })
    await tick(30_000)
    expect(authorization.cancel).toHaveBeenCalledTimes(1)
    expect(onAuthorized).not.toHaveBeenCalled()
    expect(authorization.poll).toHaveBeenCalledTimes(1)
  }
)
it("reports a polling failure and cancels the attempt", async () => {
  jest.mocked(authorization.poll).mockRejectedValue(new Error("private-provider-error"))
  mount()
  await tick(5000)
  expect(screen.getByRole("alert")).toHaveTextContent(en.deviceFailed)
  expect(screen.queryByText("private-provider-error")).not.toBeInTheDocument()
  expect(authorization.cancel).toHaveBeenCalledTimes(1)
})
it("has matching device translation keys in both locales", () => {
  expect(
    Object.keys(en)
      .filter((key) => key.startsWith("device"))
      .sort()
  ).toEqual(
    Object.keys(zh)
      .filter((key) => key.startsWith("device"))
      .sort()
  )
})
it("keeps the device attempt alive across Strict Mode effect replay", async () => {
  render(
    <StrictMode>
      <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
        <DeviceAuthorizationDialog authorization={authorization} onClose={onClose} />
      </NextIntlClientProvider>
    </StrictMode>
  )
  await tick(5000)
  expect(authorization.poll).toHaveBeenCalledTimes(1)
  expect(authorization.cancel).not.toHaveBeenCalled()
})
