jest.mock("next-intl", () => {
  const messages = {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    automation: require("@/i18n/messages/en/automation.json"),
  }
  return {
    NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    useTranslations:
      (namespace: string) => (key: string, values?: Record<string, string | number>) => {
        const value = `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (at, part) =>
              at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined,
            messages
          )
        return typeof value === "string"
          ? value.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`))
          : key
      },
  }
})
jest.mock("@/lib/automation/managed-desktop-client", () => ({ openManagedDesktop: jest.fn() }))
import { openManagedDesktop } from "@/lib/automation/managed-desktop-client"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/automation.json"
import { act } from "react"
import { useSandboxDesktop } from "@/hooks/automation/use-sandbox-desktop"
import { useSandboxDesktopStream } from "@/hooks/automation/use-sandbox-desktop-stream"
import { SandboxDesktopViewer } from "./sandbox-desktop-viewer"

jest.mock("@/hooks/automation/use-sandbox-desktop")
jest.mock("@/hooks/automation/use-sandbox-desktop-stream")
jest.mock("./sandbox-file-transfer", () => ({
  SandboxFileTransfer: () => <div role="region" aria-label="File transfer" />,
}))
const useDesktop = jest.mocked(useSandboxDesktop)
const useStream = jest.mocked(useSandboxDesktopStream)
function streamState(overrides = {}) {
  return {
    status: "unavailable" as const,
    grant: null,
    attachFrame: jest.fn(),
    fail: jest.fn().mockResolvedValue(undefined),
    claim: jest.fn().mockResolvedValue(true),
    reopen: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}
const frame = { bytes: "aA==", width: 800, height: 600, capturedAt: 42, format: "png" as const }
function state(overrides = {}) {
  return {
    frame,
    status: null,
    controlling: false,
    acquiring: false,
    error: null,
    transport: "frames" as const,
    acquire: jest.fn(),
    release: jest.fn(),
    refresh: jest.fn(),
    input: jest.fn().mockResolvedValue(true),
    ...overrides,
  }
}
function viewer() {
  return (
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="c1" enabled />
    </NextIntlClientProvider>
  )
}
function mount() {
  return render(viewer())
}
beforeEach(() => {
  jest.mocked(openManagedDesktop).mockReset()
  jest.resetAllMocks()
  useStream.mockReturnValue(streamState())
})

beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent
})

test("requires explicit takeover before keyboard or pointer input", () => {
  const model = state()
  useDesktop.mockReturnValue(model)
  mount()
  fireEvent.keyDown(screen.getByRole("img"), { key: "a" })
  expect(model.input).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Take control" }))
  expect(model.acquire).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("status")).toHaveTextContent("View only")
})

test("native streams keep image input controls without the polling or Selkies cadence label", () => {
  useDesktop.mockReturnValue({ ...state({ controlling: true }), transport: "stream" })
  mount()
  expect(screen.getByRole("img")).toBeInTheDocument()
  expect(screen.getByRole("textbox")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Release control" })).toBeEnabled()
  expect(screen.queryByText(messages.sandboxConnections.desktopViewer.cadence)).toBeNull()
  expect(screen.queryByText(messages.sandboxConnections.desktopViewer.streamCadence)).toBeNull()
})

test.each(["open", "opening", "connecting", "unmonitored", "error"])(
  "only monitored open media permits observer capture suppression: %s",
  (status) => {
    useDesktop.mockReturnValue(state())
    useStream.mockReturnValue(
      streamState({
        status,
        grant: { viewerId: "v", url: "http://localhost/", role: "viewer", healthVersion: 1 },
      })
    )
    mount()
    expect(useDesktop).toHaveBeenCalledWith(
      "c1",
      true,
      undefined,
      true,
      expect.objectContaining({ streamHealthy: status === "open" })
    )
  }
)

test("an open legacy grant cannot suppress observer screenshots", () => {
  useDesktop.mockReturnValue(state())
  useStream.mockReturnValue(
    streamState({
      status: "open",
      grant: { viewerId: "v", url: "http://localhost/", role: "viewer" },
    })
  )
  mount()
  expect(useDesktop).toHaveBeenCalledWith(
    "c1",
    true,
    undefined,
    true,
    expect.objectContaining({ streamHealthy: false })
  )
})

test("a screenshot-only Lume viewer preserves human control without a stream grant", () => {
  const model = state({ controlling: true })
  const stream = streamState({ claim: jest.fn().mockResolvedValue(false) })
  useDesktop.mockReturnValue(model)
  useStream.mockReturnValue(stream)
  render(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer
        connectionId="lume"
        enabled
        allowStreaming={false}
        transferTargetId="lume:r:1:b"
        transferFolder="/workspace"
      />
    </NextIntlClientProvider>
  )
  expect(useStream).toHaveBeenCalledWith("lume", false, undefined, expect.any(Function))
  expect(useDesktop).toHaveBeenCalledWith(
    "lume",
    true,
    undefined,
    true,
    expect.objectContaining({ onLeaseChange: undefined })
  )
  expect(stream.claim).not.toHaveBeenCalled()
  expect(model.release).not.toHaveBeenCalled()
  expect(screen.getByRole("region", { name: "File transfer" })).toBeInTheDocument()
})

test("supports IME text submission, keyboard chords and local Escape release", async () => {
  const model = state({ controlling: true })
  useDesktop.mockReturnValue(model)
  mount()
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "你好世界" } })
  fireEvent.click(screen.getByRole("button", { name: "Send text" }))
  await waitFor(() =>
    expect(model.input).toHaveBeenCalledWith({ kind: "typeText", text: "你好世界" }, null, 42)
  )
  fireEvent.keyDown(screen.getByRole("img"), { key: "a", ctrlKey: true })
  expect(model.input).toHaveBeenCalledWith({ kind: "pressKey", chord: "ctrl+a" }, null, 42)
  fireEvent.keyDown(screen.getByRole("img"), { key: "+", ctrlKey: true })
  expect(model.input).toHaveBeenCalledWith({ kind: "pressKey", chord: "ctrl+Plus" }, null, 42)
  fireEvent.keyDown(screen.getByRole("img"), { key: "Escape" })
  expect(model.release).toHaveBeenCalled()
})

test("maps rendered image coordinates to source pixels and supports scroll", () => {
  const model = state({
    controlling: true,
    frame: { ...frame, sourceWidth: 1600, sourceHeight: 1200 },
  })
  useDesktop.mockReturnValue(model)
  mount()
  const img = screen.getByRole("img")
  jest.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: 10,
    top: 20,
    right: 410,
    bottom: 320,
    width: 400,
    height: 300,
  } as DOMRect)
  fireEvent.wheel(img, { clientX: 210, clientY: 170, deltaY: 120 })
  expect(model.input).toHaveBeenCalledWith(
    { kind: "scroll", opts: { dx: 0, dy: 120 } },
    { x: 800, y: 600 },
    42
  )
})

test("does not clear text when delivery is unconfirmed", async () => {
  const model = state({ controlling: true })
  model.input.mockResolvedValue(false)
  useDesktop.mockReturnValue(model)
  mount()
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "retain" } })
  fireEvent.click(screen.getByRole("button", { name: "Send text" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Send text" })).toBeEnabled())
  expect(screen.getByRole("textbox")).toHaveValue("retain")
})

test("maps pointer drags and explicit double-click mode without extra clicks", () => {
  const model = state({ controlling: true })
  useDesktop.mockReturnValue(model)
  mount()
  const img = screen.getByRole("img")
  jest.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: 10,
    top: 20,
    right: 410,
    bottom: 320,
    width: 400,
    height: 300,
  } as DOMRect)
  fireEvent.pointerDown(img, { clientX: 110, clientY: 120, button: 0 })
  fireEvent.pointerUp(img, { clientX: 210, clientY: 170, button: 0 })
  expect(model.input).toHaveBeenCalledWith(
    { kind: "drag", to: { x: 400, y: 300 }, opts: { button: "left" } },
    { x: 200, y: 200 },
    42
  )
  model.input.mockClear()
  fireEvent.click(screen.getByRole("button", { name: "Double-click mode" }))
  fireEvent.pointerDown(img, { clientX: 110, clientY: 120, button: 0 })
  fireEvent.pointerUp(img, { clientX: 110, clientY: 120, button: 0 })
  expect(model.input).toHaveBeenCalledTimes(1)
  expect(model.input).toHaveBeenCalledWith(
    { kind: "click", button: "left", count: 2 },
    { x: 200, y: 200 },
    42
  )
})

test("a drag survives a newer capture of the same desktop dimensions", () => {
  const model = state({ controlling: true })
  useDesktop.mockReturnValue(model)
  const { rerender } = mount()
  const img = screen.getByRole("img")
  jest.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
  } as DOMRect)
  fireEvent.pointerDown(img, { clientX: 100, clientY: 100, button: 0 })
  useDesktop.mockReturnValue({ ...model, frame: { ...frame, capturedAt: 43 } })
  rerender(viewer())
  fireEvent.pointerUp(img, { clientX: 200, clientY: 200, button: 0 })
  expect(model.input).toHaveBeenCalledWith(
    { kind: "drag", to: { x: 200, y: 200 }, opts: { button: "left" } },
    { x: 100, y: 100 },
    43
  )
})

test("a desktop resize cancels a pending drag", () => {
  const model = state({ controlling: true })
  useDesktop.mockReturnValue(model)
  const { rerender } = mount()
  const img = screen.getByRole("img")
  jest.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
  } as DOMRect)
  fireEvent.pointerDown(img, { clientX: 100, clientY: 100, button: 0 })
  useDesktop.mockReturnValue({ ...model, frame: { ...frame, width: 400, capturedAt: 43 } })
  rerender(viewer())
  fireEvent.pointerUp(img, { clientX: 200, clientY: 200, button: 0 })
  expect(model.input).not.toHaveBeenCalled()
})

test("wheel input scrolls only the controlled desktop, not the containing sheet", () => {
  const model = state({ controlling: true })
  useDesktop.mockReturnValue(model)
  const { rerender } = mount()
  const img = screen.getByRole("img")
  jest.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
  } as DOMRect)
  const event = new WheelEvent("wheel", {
    clientX: 100,
    clientY: 100,
    deltaY: 3,
    deltaMode: 1,
    bubbles: true,
    cancelable: true,
  })
  fireEvent(img, event)
  expect(event.defaultPrevented).toBe(true)
  expect(model.input).toHaveBeenCalledWith(
    { kind: "scroll", opts: { dx: 0, dy: 48 } },
    { x: 100, y: 100 },
    42
  )
  useDesktop.mockReturnValue({ ...model, controlling: false })
  rerender(viewer())
  const readOnlyEvent = new WheelEvent("wheel", { deltaY: 10, bubbles: true, cancelable: true })
  fireEvent(img, readOnlyEvent)
  expect(readOnlyEvent.defaultPrevented).toBe(false)
})

test("managed viewer labels quarantine, disables takeover, and hides local transfer", () => {
  const model = state({ status: { qualified: true, state: "quarantined", canAcquire: false } })
  useDesktop.mockReturnValue(model)
  render(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="managed" enabled openDesktop={jest.fn()} />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("status")).toHaveTextContent(
    messages.sandboxConnections.desktopViewer.quarantined
  )
  expect(screen.queryByRole("region", { name: "File transfer" })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Take control" })).toBeDisabled()
  expect(
    screen.getByText(messages.sandboxConnections.desktopViewer.agentDormant)
  ).toBeInTheDocument()
})

test("managed mobile observation explicitly disables control", () => {
  useDesktop.mockReturnValue(
    state({ status: { qualified: true, state: "observer", canAcquire: true } })
  )
  render(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="managed" enabled openDesktop={jest.fn()} observeOnly />
    </NextIntlClientProvider>
  )
  expect(
    screen.getByText(messages.sandboxConnections.desktopViewer.mobileObservation)
  ).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Take control" })).toBeDisabled()
  expect(useDesktop).toHaveBeenLastCalledWith(
    "managed",
    true,
    expect.any(Function),
    false,
    expect.objectContaining({ streaming: false })
  )
})

test("a phone can explicitly take control of a qualified managed desktop", () => {
  const userAgent = jest.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
  const model = state({ status: { qualified: true, state: "observer", canAcquire: true } })
  useDesktop.mockReturnValue(model)
  render(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="managed-phone" enabled openDesktop={jest.fn()} />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Take control" }))
  expect(model.acquire).toHaveBeenCalledWith(true)
  userAgent.mockRestore()
})

test("managed take-control gesture requests explicit native takeover from observer mode", () => {
  const model = state({ status: { qualified: true, state: "observer", canAcquire: true } })
  useDesktop.mockReturnValue(model)
  render(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="managed" enabled openDesktop={jest.fn()} />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Take control" }))
  expect(model.acquire).toHaveBeenCalledWith(true)
})

test("a Selkies sandbox shows its live stream and leaves input to the stream frame", () => {
  const grant = {
    viewerId: "v1",
    url: "http://127.0.0.1:49000/?token=view",
    role: "viewer" as const,
  }
  useStream.mockReturnValue(streamState({ status: "open", grant }))
  useDesktop.mockReturnValue(state({ controlling: true }))
  mount()
  const stream = screen.getByTitle("Live sandbox desktop stream")
  expect(stream.tagName).toBe("IFRAME")
  expect(stream).toHaveAttribute("src", grant.url)
  expect(stream).toHaveAttribute("data-sandbox-stream", "c1")
  expect(stream).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-pointer-lock")
  expect(stream).toHaveAttribute("referrerpolicy", "no-referrer")
  expect(screen.queryByRole("img")).not.toBeInTheDocument()
  // The polled-input tools would send through the snapshot path; the stream replaces them.
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  expect(screen.getByText(/Click into the stream/)).toBeInTheDocument()
  expect(screen.getByText(/Live stream through Selkies/)).toBeInTheDocument()
  expect(useDesktop.mock.calls.at(-1)?.[4]).toMatchObject({ streaming: true })
})

test("control of the lease is carried into the stream, and given up when the stream cannot carry it", async () => {
  const stream = streamState({ claim: jest.fn().mockResolvedValue(false) })
  useStream.mockReturnValue(stream)
  const model = state()
  useDesktop.mockReturnValue(model)
  mount()
  const options = useDesktop.mock.calls.at(-1)?.[4]
  const lease = { token: "lease", fence: 2, expiresAt: Date.now() + 15_000 }
  await act(async () => {
    options?.onLeaseChange?.(lease)
  })
  expect(stream.claim).toHaveBeenCalledWith(lease)
  expect(model.release).toHaveBeenCalled()
  await act(async () => {
    options?.onLeaseChange?.(null)
  })
  expect(stream.reopen).toHaveBeenCalled()
})

test("a managed desktop never asks for a stream", () => {
  useDesktop.mockReturnValue(state())
  render(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="c1" enabled openDesktop={jest.fn()} />
    </NextIntlClientProvider>
  )
  expect(useStream).toHaveBeenCalledWith("c1", false, undefined, expect.any(Function))
  expect(useDesktop.mock.calls.at(-1)?.[4]).toMatchObject({ onLeaseChange: undefined })
})

test("an obsolete claim cannot release control after the viewer connection changes", async () => {
  let finish!: (claimed: boolean) => void
  useStream.mockReturnValue(
    streamState({
      claim: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve
          })
      ),
    })
  )
  const model = state()
  useDesktop.mockReturnValue(model)
  const { rerender } = mount()
  const options = useDesktop.mock.calls.at(-1)?.[4]
  act(() => options?.onLeaseChange?.({ token: "old", fence: 2, expiresAt: Date.now() + 15000 }))
  rerender(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="c2" enabled />
    </NextIntlClientProvider>
  )
  await act(async () => finish(false))
  expect(model.release).not.toHaveBeenCalled()
})

function managedViewer(qualified = true) {
  useDesktop.mockReturnValue(state())
  return (
    <SandboxDesktopViewer
      connectionId="managed:desktop:1"
      enabled
      openDesktop={jest.fn()}
      managed={{
        target: { kind: "local" },
        ref: { desktopId: "desktop", generation: 1 },
        operationsQualified: qualified,
      }}
    />
  )
}
test("managed clipboard is explicit and disabled with a recipe-8 reason", () => {
  render(managedViewer(false))
  expect(screen.getByRole("button", { name: "Read desktop clipboard" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Send text to desktop clipboard" })).toBeDisabled()
  expect(screen.getByText(/passes qualification for desktop release recipe 8/)).toBeInTheDocument()
  expect(openManagedDesktop).not.toHaveBeenCalled()
})
test("managed clipboard obtains and releases a holder lease without automatic synchronization", async () => {
  const lease = { token: "holder", fence: 1, expiresAt: Date.now() + 15000 }
  const session = {
    acquire: jest.fn().mockResolvedValue(lease),
    clipboardGet: jest.fn().mockResolvedValue({ kind: "clipboard-get", text: "from desktop" }),
    clipboardSet: jest.fn().mockResolvedValue({ kind: "clipboard-set", bytes: 12 }),
    release: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  }
  jest.mocked(openManagedDesktop).mockResolvedValue(session as never)
  render(managedViewer())
  expect(session.clipboardGet).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Read desktop clipboard" }))
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Clipboard text" })).toHaveValue("from desktop")
  )
  await waitFor(() => expect(session.release).toHaveBeenCalledWith(lease))
  fireEvent.change(screen.getByRole("textbox", { name: "Clipboard text" }), {
    target: { value: "to desktop" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Send text to desktop clipboard" }))
  await waitFor(() => expect(session.clipboardSet).toHaveBeenCalledWith(lease, "to desktop"))
  await waitFor(() => expect(session.close).toHaveBeenCalledTimes(2))
})
test("revoking operations qualification discards a late clipboard response", async () => {
  let resolve!: (value: { kind: string; text: string }) => void
  const session = {
    acquire: jest.fn().mockResolvedValue({ token: "holder", fence: 1 }),
    clipboardGet: jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    ),
    release: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  }
  jest.mocked(openManagedDesktop).mockResolvedValue(session as never)
  const { rerender } = render(managedViewer())
  fireEvent.click(screen.getByRole("button", { name: "Read desktop clipboard" }))
  await waitFor(() => expect(session.clipboardGet).toHaveBeenCalled())
  rerender(managedViewer(false))
  await act(async () => {
    resolve({ kind: "clipboard-get", text: "late private text" })
  })
  expect(screen.getByRole("textbox", { name: "Clipboard text" })).toHaveValue("")
  expect(session.release).toHaveBeenCalled()
})

test.each([false, true])(
  "managed clipboard enforces the 1 MiB UTF-8 limit on %s writes",
  async (write) => {
    const oversized = "界".repeat(Math.floor((1024 * 1024) / 3) + 1)
    const session = {
      acquire: jest.fn().mockResolvedValue({ token: "holder", fence: 1 }),
      clipboardGet: jest.fn().mockResolvedValue({ kind: "clipboard-get", text: oversized }),
      clipboardSet: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
    }
    jest.mocked(openManagedDesktop).mockResolvedValue(session as never)
    render(managedViewer())
    if (write)
      fireEvent.change(screen.getByRole("textbox", { name: "Clipboard text" }), {
        target: { value: oversized },
      })
    fireEvent.click(
      screen.getByRole("button", {
        name: write ? "Send text to desktop clipboard" : "Read desktop clipboard",
      })
    )
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(session.clipboardSet).not.toHaveBeenCalled()
    if (write) expect(openManagedDesktop).not.toHaveBeenCalled()
    else {
      expect(screen.getByRole("textbox", { name: "Clipboard text" })).toHaveValue("")
      await waitFor(() => expect(session.release).toHaveBeenCalled())
    }
  }
)

test.each([false, true])(
  "touch controls mount only while controlling on a touch screen: %s",
  (controlling) => {
    const ua = jest.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
    useDesktop.mockReturnValue(state({ controlling }))
    mount()
    if (controlling) expect(screen.getByRole("toolbar", { name: "Special keys" })).toBeVisible()
    else expect(screen.queryByRole("toolbar", { name: "Special keys" })).toBeNull()
    ua.mockRestore()
  }
)

test.each([false, true])("managed clipboard accepts exactly 1 MiB: write=%s", async (write) => {
  const text = "x".repeat(1024 * 1024)
  const session = {
    acquire: jest.fn().mockResolvedValue({ token: "holder", fence: 1 }),
    clipboardGet: jest.fn().mockResolvedValue({ kind: "clipboard-get", text }),
    clipboardSet: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  }
  jest.mocked(openManagedDesktop).mockResolvedValue(session as never)
  render(managedViewer())
  if (write)
    fireEvent.change(screen.getByRole("textbox", { name: "Clipboard text" }), {
      target: { value: text },
    })
  fireEvent.click(
    screen.getByRole("button", {
      name: write ? "Send text to desktop clipboard" : "Read desktop clipboard",
    })
  )
  await waitFor(() => expect(session.close).toHaveBeenCalled())
  expect(screen.queryByRole("alert")).toBeNull()
  if (write) expect(session.clipboardSet).toHaveBeenCalledWith({ token: "holder", fence: 1 }, text)
  else expect(screen.getByRole("textbox", { name: "Clipboard text" })).toHaveValue(text)
})
