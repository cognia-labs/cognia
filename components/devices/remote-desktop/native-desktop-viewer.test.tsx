jest.mock("next-intl", () => {
  const messages = {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    remoteDesktop: require("@/i18n/messages/en/remoteDesktop.json"),
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
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/remoteDesktop.json"
import fixture from "@/crates/cognia-remote-desktop/fixtures/frame-v1.json"
import { NativeDesktopViewer } from "./native-desktop-viewer"
import type { RemoteDesktopRawChannel } from "@/lib/remote-desktop/stream"
import type { NativeFrameStreamDeps } from "@/lib/remote-desktop/native-stream"

function setup() {
  const channels: RemoteDesktopRawChannel[] = []
  const sends = jest.fn()
  const closed = jest.fn()
  const openSession = jest.fn<
    ReturnType<NonNullable<NativeFrameStreamDeps["openSession"]>>,
    Parameters<NonNullable<NativeFrameStreamDeps["openSession"]>>
  >(async (_, args) => ({
    sessionId: String(channels.length),
    mode: args.mode,
    transport: "companion",
    expiresAt: Date.now() + 15000,
    ...(args.mode === "control"
      ? { lease: { token: "lease", fence: 1, expiresAt: Date.now() + 15000 } }
      : {}),
  }))
  const closeSession = jest.fn(async () => undefined)
  const deps: NativeFrameStreamDeps = {
    openSession,
    closeSession,
    renewSession: async () => ({ expiresAt: Date.now() + 15000 }),
    openStream: async () => {
      const channel = {
        readyState: "open",
        binaryType: "arraybuffer",
        protocol: "",
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: sends,
        close: closed,
      } as RemoteDesktopRawChannel
      channels.push(channel)
      return { connection: channel, close: closed }
    },
  }
  return {
    channels,
    sends,
    closeSession,
    openSession,
    deps,
    deliver: (index: number) => {
      const bytes = Uint8Array.from(Buffer.from(fixture.hex, "hex"))
      act(() => channels[index]!.onmessage?.({ data: bytes.buffer } as MessageEvent))
    },
  }
}

beforeAll(() => {
  URL.createObjectURL = jest.fn(() => "blob:native-frame")
  URL.revokeObjectURL = jest.fn()
})

test("a phone takes Control through the broker and releases when the viewer closes", async () => {
  const ua = jest.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
  const f = setup()
  const { unmount } = render(
    <NextIntlClientProvider locale="en" messages={{ remoteDesktop: messages }}>
      <NativeDesktopViewer
        host={{ kind: "remote", hostRef: "host" }}
        targetId="sandbox:a"
        deps={f.deps}
      />
    </NextIntlClientProvider>
  )
  await waitFor(() => expect(f.channels).toHaveLength(1))
  f.deliver(0)
  const take = await screen.findByRole("button", { name: "Take control" })
  await waitFor(() => expect(take).toBeEnabled())
  fireEvent.click(take)
  await waitFor(() => expect(f.channels).toHaveLength(2))
  expect(f.openSession).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ mode: "control", takeover: true })
  )
  f.deliver(1)
  expect(await screen.findByRole("toolbar", { name: "Special keys" })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Tab" }))
  expect(f.sends).toHaveBeenCalledTimes(1)
  const bytes = f.sends.mock.calls[0]![0] as Uint8Array
  expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4))).action).toEqual({
    kind: "pressKey",
    chord: "Tab",
  })
  unmount()
  await waitFor(() => expect(f.closeSession).toHaveBeenCalledWith(expect.anything(), "1"))
  ua.mockRestore()
})

test("equivalent Host objects retain Control and switching Hosts requires a new Take control", async () => {
  const f = setup()
  const viewer = (hostRef: string) => (
    <NativeDesktopViewer host={{ kind: "remote", hostRef }} targetId="sandbox:a" deps={f.deps} />
  )
  const { rerender } = render(viewer("first"))
  await waitFor(() => expect(f.channels).toHaveLength(1))
  f.deliver(0)
  fireEvent.click(await screen.findByRole("button", { name: "Take control" }))
  await waitFor(() => expect(f.channels).toHaveLength(2))
  f.deliver(1)
  rerender(viewer("first"))
  await act(async () => {})
  expect(f.openSession).toHaveBeenCalledTimes(2)
  rerender(viewer("second"))
  await waitFor(() => expect(f.channels).toHaveLength(3))
  expect(f.openSession).toHaveBeenLastCalledWith(
    { kind: "remote", hostRef: "second" },
    expect.objectContaining({ mode: "view", takeover: false })
  )
  expect(f.closeSession).toHaveBeenCalledWith({ kind: "remote", hostRef: "first" }, "1")
  f.deliver(2)
  expect(await screen.findByRole("button", { name: "Take control" })).toBeEnabled()
})

test("a failed native session renders the translated alert", async () => {
  const f = setup()
  f.openSession.mockRejectedValueOnce(new Error("remote_desktop_native_unavailable"))
  render(
    <NativeDesktopViewer
      host={{ kind: "remote", hostRef: "host" }}
      targetId="sandbox:a"
      deps={f.deps}
    />
  )
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.errors.unavailable)
  expect(f.channels).toHaveLength(0)
})
