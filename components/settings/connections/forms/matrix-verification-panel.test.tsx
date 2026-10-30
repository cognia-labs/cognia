/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MatrixVerificationPanel } from "./matrix-verification-panel"
import { getBus } from "@/lib/connectors/bus"
jest.mock("@/lib/connectors/bus", () => ({ getBus: jest.fn() }))

function setup() {
  const state = {
    userId: "@alice:test",
    deviceId: "ALICE",
    flowId: "flow",
    state: "ready",
    deviceVerified: false,
  }
  const api = {
    pending: jest.fn().mockResolvedValue([{ ...state, state: "requested" }]),
    interact: jest.fn().mockResolvedValue(state),
  }
  jest.mocked(getBus).mockReturnValue({ getAdapter: () => ({ verification: api }) } as never)
  return { api, state }
}
async function request() {
  fireEvent.change(screen.getByLabelText("Peer Matrix user"), { target: { value: "@alice:test" } })
  fireEvent.change(screen.getByLabelText("Peer device ID"), { target: { value: "ALICE" } })
  fireEvent.click(screen.getByRole("button", { name: "Request verification" }))
  await screen.findByRole("button", { name: "Compare numbers" })
}
test("SAS trust needs an explicit match and mismatch uses cancellation", async () => {
  const { api, state } = setup()
  render(<MatrixVerificationPanel adapterId="bob" available />)
  await request()
  api.interact.mockResolvedValue({ ...state, state: "sas", decimals: [1234, 5678, 9012] })
  fireEvent.click(screen.getByRole("button", { name: "Compare numbers" }))
  expect(await screen.findByLabelText("Verification numbers")).toHaveTextContent(
    "1234 · 5678 · 9012"
  )
  expect(api.interact.mock.calls.map(([call]) => call.action)).toEqual(["request", "startSas"])
  fireEvent.click(screen.getByRole("button", { name: "The numbers do not match" }))
  await waitFor(() =>
    expect(api.interact).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "cancel", flowId: "flow" })
    )
  )
})
test("QR display is transient and cannot confirm an unscanned code", async () => {
  const { api, state } = setup()
  const modules = new Array(441).fill(true)
  const bytes = [77, 65, 84, 82, 73, 88, 0, 1]
  const view = render(<MatrixVerificationPanel adapterId="bob" available />)
  await request()
  api.interact.mockResolvedValue({
    ...state,
    state: "qr",
    qrImage: { size: 21, modules },
    qrBytes: bytes,
    scanned: false,
  })
  fireEvent.click(screen.getByRole("button", { name: "Show QR code" }))
  await screen.findByRole("img", { name: "Matrix verification QR code" })
  expect(screen.queryByRole("button", { name: /Confirm the other device/ })).not.toBeInTheDocument()
  expect(bytes.every((byte) => byte === 0)).toBe(true)
  view.unmount()
  expect(modules.every((value) => !value)).toBe(true)
})
test("a replaced runtime cannot publish a late QR result", async () => {
  const { api, state } = setup()
  render(<MatrixVerificationPanel adapterId="bob" available />)
  await request()
  let complete!: (value: unknown) => void
  api.interact.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  fireEvent.click(screen.getByRole("button", { name: "Show QR code" }))
  jest.mocked(getBus).mockReturnValue({ getAdapter: () => undefined } as never)
  const bytes = [1, 2, 3]
  const modules = [true]
  await act(async () =>
    complete({ ...state, state: "qr", qrBytes: bytes, qrImage: { size: 1, modules } })
  )
  expect(screen.queryByRole("img")).not.toBeInTheDocument()
  expect(bytes).toEqual([0, 0, 0])
  expect(modules).toEqual([false])
})
test("unavailable connectors cannot send requests", () => {
  const { api } = setup()
  render(<MatrixVerificationPanel adapterId="bob" available={false} />)
  expect(screen.getByRole("button", { name: "Request verification" })).toBeDisabled()
  expect(api.interact).not.toHaveBeenCalled()
})
test("incoming requests stay bound to the adapter that discovered them", async () => {
  const { api } = setup()
  render(<MatrixVerificationPanel adapterId="bob" available />)
  fireEvent.change(screen.getByLabelText("Peer Matrix user"), { target: { value: "@alice:test" } })
  fireEvent.click(screen.getByRole("button", { name: "Find incoming requests" }))
  const accept = await screen.findByRole("button", { name: "Accept request from ALICE" })
  const replacement = { ...api, interact: jest.fn() }
  jest
    .mocked(getBus)
    .mockReturnValue({ getAdapter: () => ({ verification: replacement }) } as never)
  fireEvent.click(accept)
  await screen.findByRole("alert")
  expect(replacement.interact).not.toHaveBeenCalled()
})
test("camera permission completion after cancellation stops all tracks", async () => {
  const { api, state } = setup()
  let grant!: (value: unknown) => void
  const stop = jest.fn()
  const getUserMedia = jest.fn(
    () =>
      new Promise((resolve) => {
        grant = resolve
      })
  )
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
    },
  })
  render(<MatrixVerificationPanel adapterId="bob" available />)
  await request()
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }))
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }))
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  api.interact.mockResolvedValue({ ...state, state: "cancelled" })
  fireEvent.click(screen.getByRole("button", { name: "Cancel verification" }))
  await screen.findByText("Verification cancelled")
  await act(async () => grant({ getTracks: () => [{ stop }] }))
  expect(stop).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText("QR camera preview")).not.toBeInTheDocument()
})

test("a stale video play rejection cannot stop the next camera session", async () => {
  setup()
  const firstStop = jest.fn(),
    secondStop = jest.fn()
  let rejectPlay!: (error: Error) => void
  const play = jest
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPlay = reject
        })
    )
    .mockResolvedValue(undefined)
  const canvas = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: jest
        .fn()
        .mockResolvedValueOnce({ getTracks: () => [{ stop: firstStop }] })
        .mockResolvedValueOnce({ getTracks: () => [{ stop: secondStop }] }),
    },
  })
  const view = render(<MatrixVerificationPanel adapterId="bob" available />)
  try {
    await request()
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }))
    await screen.findByLabelText("QR camera preview")
    fireEvent.click(screen.getByRole("button", { name: "Stop camera" }))
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }))
    await screen.findByLabelText("QR camera preview")
    await act(async () => rejectPlay(new Error("old AbortError")))
    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(secondStop).not.toHaveBeenCalled()
    expect(screen.getByLabelText("QR camera preview")).toBeInTheDocument()
    view.unmount()
    expect(secondStop).toHaveBeenCalledTimes(1)
  } finally {
    view.unmount()
    play.mockRestore()
    canvas.mockRestore()
  }
})

test("a transient status error preserves the displayed QR image", async () => {
  jest.useFakeTimers()
  try {
    const { api, state } = setup()
    render(<MatrixVerificationPanel adapterId="bob" available />)
    await request()
    api.interact.mockResolvedValueOnce({
      ...state,
      state: "qr",
      qrImage: { size: 21, modules: new Array(441).fill(true) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Show QR code" }))
    await screen.findByRole("img", { name: "Matrix verification QR code" })
    api.interact.mockRejectedValueOnce(new Error("temporary status failure"))
    await act(async () => jest.advanceTimersByTime(1000))
    expect(screen.getByRole("img", { name: "Matrix verification QR code" })).toBeInTheDocument()
    api.interact.mockResolvedValue({ ...state, state: "qr" })
    await act(async () => jest.advanceTimersByTime(1000))
    expect(screen.getByRole("img", { name: "Matrix verification QR code" })).toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})
test("a pending trust refresh cannot reset operation ownership and lock the next flow", async () => {
  const { api, state } = setup()
  api.interact.mockResolvedValue({ ...state, state: "done" })
  let finish!: (value: unknown) => void
  const refreshTrust = jest.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )

  // Keep the API identity stable, as the production adapter does.
  const owner = { ...api, refreshTrust }
  jest.mocked(getBus).mockReturnValue({ getAdapter: () => ({ verification: owner }) } as never)
  render(<MatrixVerificationPanel adapterId="bob" available />)
  fireEvent.change(screen.getByLabelText("Peer Matrix user"), { target: { value: "@alice:test" } })
  fireEvent.change(screen.getByLabelText("Peer device ID"), { target: { value: "ALICE" } })
  fireEvent.click(screen.getByRole("button", { name: "Request verification" }))
  fireEvent.click(await screen.findByRole("button", { name: "Refresh device trust" }))
  expect(screen.getByRole("button", { name: "Verify another device" })).toBeDisabled()
  await act(async () => finish({ ...state, state: "done", deviceVerified: true }))
  fireEvent.click(screen.getByRole("button", { name: "Verify another device" }))
  expect(screen.getByRole("button", { name: "Request verification" })).toBeEnabled()
})
test("failed one-shot SAS delivery keeps an explicit retry with the original input", async () => {
  jest.useFakeTimers()
  try {
    const { api, state } = setup()
    render(<MatrixVerificationPanel adapterId="bob" available />)
    await request()
    api.interact.mockRejectedValueOnce(new Error("HTTP 503"))
    fireEvent.click(screen.getByRole("button", { name: "Compare numbers" }))
    const retry = await screen.findByRole("button", { name: "Retry verification action" })
    const original = api.interact.mock.calls.at(-1)![0]
    api.interact.mockResolvedValue({ ...state, state: "sas", sasStartedByUs: true })
    await act(async () => jest.advanceTimersByTime(3000))
    expect(api.interact).toHaveBeenCalledTimes(2)
    fireEvent.click(retry)
    await waitFor(() => expect(api.interact).toHaveBeenCalledTimes(3))
    expect(api.interact.mock.calls.at(-1)![0]).toEqual(original)
    expect(
      screen.queryByRole("button", { name: "Retry verification action" })
    ).not.toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})
