import { act, renderHook } from "@testing-library/react"
import { useSandboxDesktop } from "./use-sandbox-desktop"
import { sandboxClient } from "@/lib/automation/sandbox-client"
import { openNativeFrameStream, type NativeFrameStream } from "@/lib/remote-desktop/native-stream"
import type { NativeFrame } from "@/lib/remote-desktop/frames"

jest.mock("@/lib/remote-desktop/native-stream", () => ({ openNativeFrameStream: jest.fn() }))

jest.mock("@/lib/automation/sandbox-client", () => ({
  sandboxClient: {
    desktopFrame: jest.fn(),
    acquireControl: jest.fn(),
    renewControl: jest.fn(),
    releaseControl: jest.fn(),
    controlInput: jest.fn(),
  },
}))
const client = jest.mocked(sandboxClient)
const openNative = jest.mocked(openNativeFrameStream)
const frame = { bytes: "aA==", width: 800, height: 600, capturedAt: 42, format: "png" as const }
// The local Host issues a single-use proof with every capture, and acquiring
// control advances the fence, exactly like the managed Host.
let fence = 1
let frameSeq = 0
function proofFor(screenshot: typeof frame = frame) {
  frameSeq += 1
  return { screenshot, frameId: `f${frameSeq}`, fence, expiresAt: Date.now() + 5000 }
}
async function tick(ms = 0) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}
beforeEach(() => {
  jest.useFakeTimers()
  jest.resetAllMocks()
  openNative.mockRejectedValue(new Error("native stream unavailable"))
  fence = 1
  frameSeq = 0
  client.desktopFrame.mockImplementation(async () => proofFor())
  client.acquireControl.mockImplementation(async () => {
    fence += 1
    return { token: "lease", fence, expiresAt: Date.now() + 15000 }
  })
  client.renewControl.mockImplementation(async () => ({
    token: "lease",
    fence,
    expiresAt: Date.now() + 15000,
  }))
  client.releaseControl.mockResolvedValue(undefined)
  client.controlInput.mockResolvedValue(undefined)
})
afterEach(() => jest.useRealTimers())

function nativeFrames() {
  let pending: ((frame: IteratorResult<NativeFrame>) => void) | undefined
  const queued: NativeFrame[] = []
  const close = jest.fn(() => {
    pending?.({ done: true, value: undefined })
    pending = undefined
  })
  const stream: NativeFrameStream = {
    close,
    [Symbol.asyncIterator]: () => ({
      next: () =>
        queued.length
          ? Promise.resolve({ done: false, value: queued.shift()! })
          : new Promise((resolve) => {
              pending = resolve
            }),
    }),
  }
  return {
    stream,
    close,
    async send(overrides: Partial<NativeFrame> = {}) {
      await act(async () => {
        const value: NativeFrame = {
          jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          frameId: `native-${++frameSeq}`,
          fence,
          capturedAtMs: Date.now(),
          width: 800,
          height: 600,
          encoding: "jpeg",
          payloadBytes: 4,
          ...overrides,
        }
        if (pending) {
          const resolve = pending
          pending = undefined
          resolve({ done: false, value })
        } else queued.push(value)
      })
    },
  }
}

describe("native Host frames", () => {
  test.each([false, true])(
    "streams pixels and fresh input proofs (managed: %s)",
    async (managed) => {
      const source = nativeFrames()
      openNative.mockResolvedValue(source.stream)
      const desktop = managed ? managedSession() : undefined
      const open = desktop ? jest.fn().mockResolvedValue(desktop) : undefined
      const { result } = renderHook(() => useSandboxDesktop("c1", true, open))
      await tick()
      expect(openNative).toHaveBeenCalledWith(
        { kind: "local" },
        managed ? "managed-desktop:c1" : "sandbox:c1",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onReconnect: expect.any(Function),
        })
      )
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
      await source.send({ jpeg })
      expect(result.current.frame).toMatchObject({ bytes: "/9j/2Q==", format: "jpeg", width: 800 })
      let acquired: Promise<void> | undefined
      act(() => {
        acquired = result.current.acquire()
      })
      await tick()
      desktop?.status.mockResolvedValue({
        qualified: true,
        state: "controlled",
        controllerIsSelf: true,
        fence: 2,
        canAcquire: false,
      })
      expect(result.current.controlling).toBe(false)
      // An observer tick arriving after acquire cannot authorize input.
      await source.send({ jpeg, fence: 1, encoding: "unchanged", payloadBytes: 0 })
      expect(result.current.controlling).toBe(false)
      await source.send({ jpeg, fence: 2, encoding: "unchanged", payloadBytes: 0 })
      await act(async () => {
        await acquired
      })
      expect(result.current.controlling).toBe(true)
      const pixels = result.current.frame
      await tick(2000)
      await source.send({
        jpeg,
        fence: 2,
        frameId: "header-proof",
        encoding: "unchanged",
        payloadBytes: 0,
      })
      expect(result.current.frame).toBe(pixels)
      await act(async () => {
        expect(
          await result.current.input({ kind: "click" }, { x: 1, y: 2 }, pixels!.capturedAt)
        ).toBe(true)
        await result.current.refresh()
      })
      if (desktop) {
        expect(desktop.input).toHaveBeenCalledWith(
          expect.objectContaining({ fence: 2 }),
          expect.objectContaining({ frameId: "header-proof", fence: 2 }),
          { x: 1, y: 2 },
          { kind: "click" }
        )
        expect(desktop.frame).not.toHaveBeenCalled()
        expect(desktop.status).toHaveBeenCalled()
      } else {
        expect(client.controlInput).toHaveBeenCalledWith(
          "c1",
          "lease",
          2,
          "header-proof",
          { x: 1, y: 2 },
          { kind: "click" }
        )
      }
      await tick(2000)
      expect(client.desktopFrame).not.toHaveBeenCalled()
    }
  )

  test("only converts changed JPEGs and refreshes proof freshness on header-only ticks", async () => {
    const source = nativeFrames()
    openNative.mockResolvedValue(source.stream)
    const encode = jest.spyOn(window, "btoa")
    try {
      const { result } = renderHook(() => useSandboxDesktop("c1", true))
      await tick()
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
      await source.send({ jpeg })
      let acquired: Promise<void> | undefined
      act(() => {
        acquired = result.current.acquire()
      })
      await tick()
      await source.send({ jpeg, fence: 2, encoding: "unchanged", payloadBytes: 0 })
      await act(async () => {
        await acquired
      })
      const pixels = result.current.frame
      for (let tickIndex = 0; tickIndex < 3; tickIndex += 1) {
        await tick(2000)
        await source.send({ jpeg, encoding: "unchanged", payloadBytes: 0 })
      }
      expect(result.current.frame).toBe(pixels)
      expect(encode).toHaveBeenCalledTimes(1)
      await act(async () => {
        expect(
          await result.current.input({ kind: "typeText", text: "a" }, null, pixels!.capturedAt)
        ).toBe(true)
        expect(
          await result.current.input({ kind: "typeText", text: "b" }, null, pixels!.capturedAt)
        ).toBe(false)
      })
      await source.send({ frameId: "changed" })
      expect(encode).toHaveBeenCalledTimes(2)
    } finally {
      encode.mockRestore()
    }
  })

  test("a reconnect releases control and recovers observation without polling or acquiring again", async () => {
    const source = nativeFrames()
    openNative.mockResolvedValue(source.stream)
    const { result } = renderHook(() => useSandboxDesktop("c1", true))
    await tick()
    await source.send()
    act(() => {
      void result.current.acquire()
    })
    await tick()
    await source.send()
    expect(result.current.controlling).toBe(true)
    await act(async () => {
      openNative.mock.calls[0]![2]!.onReconnect!(1, new Error("dropped"))
    })
    expect(result.current.controlling).toBe(false)
    expect(result.current.frame).toBeNull()
    expect(client.releaseControl).toHaveBeenCalledTimes(1)
    await source.send({ fence: 3 })
    await tick(5000)
    expect(result.current.frame).not.toBeNull()
    expect(result.current.controlling).toBe(false)
    expect(openNative).toHaveBeenCalledTimes(1)
    expect(client.acquireControl).toHaveBeenCalledTimes(1)
    expect(client.renewControl).not.toHaveBeenCalled()
    expect(client.desktopFrame).not.toHaveBeenCalled()
  })

  test("a lease acquired after a stream drop is released instead of restoring control", async () => {
    const source = nativeFrames()
    openNative.mockResolvedValue(source.stream)
    let complete!: (lease: { token: string; fence: number; expiresAt: number }) => void
    client.acquireControl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const { result } = renderHook(() => useSandboxDesktop("c1", true))
    await tick()
    await source.send()
    act(() => {
      void result.current.acquire()
    })
    await tick()
    await act(async () => {
      openNative.mock.calls[0]![2]!.onReconnect!(1, new Error("dropped"))
      complete({ token: "late", fence: 2, expiresAt: Date.now() + 15000 })
    })
    await source.send({ fence: 3 })
    expect(result.current.controlling).toBe(false)
    expect(client.releaseControl).toHaveBeenCalledWith("c1", "late", 2)
    expect(client.acquireControl).toHaveBeenCalledTimes(1)
    expect(client.desktopFrame).not.toHaveBeenCalled()
  })

  test("acquisition releases its lease if the stream never supplies a controller-fence frame", async () => {
    const source = nativeFrames()
    openNative.mockResolvedValue(source.stream)
    const { result } = renderHook(() => useSandboxDesktop("c1", true))
    await tick()
    await source.send()
    let acquired: Promise<void> | undefined
    act(() => {
      acquired = result.current.acquire()
    })
    await tick()
    await source.send({ fence: 1 })
    await tick(5000)
    await act(async () => {
      await acquired
    })
    expect(result.current.acquiring).toBe(false)
    expect(result.current.controlling).toBe(false)
    expect(result.current.error).toBe("control")
    expect(client.releaseControl).toHaveBeenCalledWith("c1", "lease", 2)
    expect(client.desktopFrame).not.toHaveBeenCalled()
  })

  test("a changed fence releases established control and only observation recovers", async () => {
    const source = nativeFrames()
    openNative.mockResolvedValue(source.stream)
    const { result } = renderHook(() => useSandboxDesktop("c1", true))
    await tick()
    await source.send()
    act(() => {
      void result.current.acquire()
    })
    await tick()
    await source.send()
    expect(result.current.controlling).toBe(true)
    await source.send({ fence: 3 })
    expect(result.current.frame).toBeNull()
    expect(result.current.controlling).toBe(false)
    expect(client.releaseControl).toHaveBeenCalledWith("c1", "lease", 2)
    await source.send({ fence: 3 })
    expect(result.current.frame).not.toBeNull()
    expect(client.acquireControl).toHaveBeenCalledTimes(1)
    expect(
      await result.current.input(
        { kind: "typeText", text: "a" },
        null,
        result.current.frame!.capturedAt
      )
    ).toBe(false)
    expect(client.desktopFrame).not.toHaveBeenCalled()
  })

  test("managed quarantine and session invalidation cannot restore streamed pixels", async () => {
    const source = nativeFrames()
    openNative.mockResolvedValue(source.stream)
    const desktop = managedSession()
    const open = jest.fn().mockResolvedValue(desktop)
    const { result } = renderHook(() => useSandboxDesktop("cloud", true, open))
    await tick()
    await source.send()
    expect(result.current.frame).not.toBeNull()
    desktop.status.mockResolvedValue({ qualified: true, state: "quarantined", canAcquire: false })
    await tick(1000)
    await source.send()
    expect(result.current.frame).toBeNull()
    await act(async () => {
      desktop.invalidate()
    })
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(openNative.mock.calls[0]![2]!.signal!.aborted).toBe(true)
    expect(result.current.error).toBe("session")
    expect(desktop.frame).not.toHaveBeenCalled()
  })

  test("returning to a visible document reopens observation without resuming control", async () => {
    const first = nativeFrames()
    const second = nativeFrames()
    openNative.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream)
    const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false)
    try {
      const { result } = renderHook(() => useSandboxDesktop("c1", true))
      await tick()
      await first.send()
      act(() => {
        void result.current.acquire()
      })
      await tick()
      await first.send()
      expect(result.current.controlling).toBe(true)
      hidden.mockReturnValue(true)
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"))
      })
      hidden.mockReturnValue(false)
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await second.send({ fence: 3 })
      expect(openNative).toHaveBeenCalledTimes(2)
      expect(first.close).toHaveBeenCalledTimes(1)
      expect(result.current.frame).not.toBeNull()
      expect(result.current.controlling).toBe(false)
      expect(client.acquireControl).toHaveBeenCalledTimes(1)
      expect(client.desktopFrame).not.toHaveBeenCalled()
    } finally {
      hidden.mockRestore()
    }
  })

  test.each(["disable", "target", "hidden", "unmount"])(
    "closes and aborts the stream on %s",
    async (change) => {
      const source = nativeFrames()
      openNative.mockResolvedValue(source.stream)
      const { result, rerender, unmount } = renderHook(
        ({ id, enabled }) => useSandboxDesktop(id, enabled),
        {
          initialProps: { id: "c1", enabled: true },
        }
      )
      await tick()
      await source.send()
      const signal = openNative.mock.calls[0]![2]!.signal!
      if (change === "disable") rerender({ id: "c1", enabled: false })
      else if (change === "target") rerender({ id: "c2", enabled: true })
      else if (change === "unmount") unmount()
      else {
        const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(true)
        try {
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"))
          })
          expect(result.current.frame).toBeNull()
        } finally {
          hidden.mockRestore()
        }
      }
      expect(source.close).toHaveBeenCalledTimes(1)
      expect(signal.aborted).toBe(true)
      expect(client.desktopFrame).not.toHaveBeenCalled()
    }
  )

  test("a late initial open is reclaimed and cannot start fallback after cleanup", async () => {
    const source = nativeFrames()
    let complete!: (stream: NativeFrameStream) => void
    openNative.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const { unmount } = renderHook(() => useSandboxDesktop("c1", true))
    await tick()
    await tick(5000)
    expect(client.desktopFrame).not.toHaveBeenCalled()
    unmount()
    await act(async () => {
      complete(source.stream)
    })
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(client.desktopFrame).not.toHaveBeenCalled()
  })
})

test("starts read-only, polls sequentially, and stops on unmount", async () => {
  const { result, unmount } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  expect(openNative).toHaveBeenCalledTimes(1)
  expect(result.current.transport).toBe("frames")
  expect(result.current.frame).toEqual(frame)
  expect(result.current.controlling).toBe(false)
  expect(await result.current.input({ kind: "click" }, { x: 1, y: 2 }, 42)).toBe(false)
  expect(client.controlInput).not.toHaveBeenCalled()
  await tick(1000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
  unmount()
  await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
})

test.each(["reacquire", "replace", "unmount"])(
  "a delayed release notification cannot affect %s control lifecycle",
  async (action) => {
    const onLeaseChange = jest.fn()
    let finish!: () => void
    client.releaseControl.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const { result, rerender, unmount } = renderHook(
      ({ id }) => useSandboxDesktop(id, true, undefined, true, { onLeaseChange }),
      { initialProps: { id: "c1" } }
    )
    await tick()
    await act(async () => {
      await result.current.acquire()
    })
    let released: Promise<void> | undefined
    act(() => {
      released = result.current.release()
    })
    if (action === "reacquire")
      await act(async () => {
        await result.current.acquire()
      })
    else if (action === "replace") {
      rerender({ id: "c2" })
      await tick()
    } else unmount()
    onLeaseChange.mockClear()
    await act(async () => {
      finish()
      await released
    })
    expect(onLeaseChange).not.toHaveBeenCalledWith(null)
    if (action === "reacquire") expect(result.current.controlling).toBe(true)
  }
)

test("duplicate releases still publish the settled release once", async () => {
  const onLeaseChange = jest.fn()
  let finish!: () => void
  client.releaseControl.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { onLeaseChange })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  onLeaseChange.mockClear()
  let released: Promise<void> | undefined
  act(() => {
    released = result.current.release()
  })
  await act(async () => {
    await result.current.release()
  })
  await act(async () => {
    finish()
    await released
  })
  expect(client.releaseControl).toHaveBeenCalledTimes(1)
  expect(onLeaseChange).toHaveBeenCalledTimes(1)
  expect(onLeaseChange).toHaveBeenCalledWith(null)
})

test("a claim failure can release only its own current token and fence", async () => {
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  await act(async () => {
    await result.current.release({ token: "old", fence: 2, expiresAt: Date.now() + 15000 })
    await result.current.release({ token: "lease", fence: 1, expiresAt: Date.now() + 15000 })
  })
  expect(client.releaseControl).not.toHaveBeenCalled()
  expect(result.current.controlling).toBe(true)
  await act(async () => {
    await result.current.release({ token: "lease", fence: 2, expiresAt: Date.now() + 15000 })
  })
  expect(client.releaseControl).toHaveBeenCalledWith("c1", "lease", 2)
  expect(result.current.controlling).toBe(false)
})

test("a settled release is published after an overlapping acquisition fails", async () => {
  const onLeaseChange = jest.fn()
  let finishRelease!: () => void
  let failAcquire!: (error: Error) => void
  client.releaseControl.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRelease = resolve
      })
  )
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { onLeaseChange })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  let release: Promise<void> | undefined
  act(() => {
    release = result.current.release()
  })
  client.acquireControl.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failAcquire = reject
      })
  )
  let acquire: Promise<void> | undefined
  act(() => {
    acquire = result.current.acquire()
  })
  onLeaseChange.mockClear()
  await act(async () => {
    finishRelease()
    await release
  })
  expect(onLeaseChange).not.toHaveBeenCalled()
  await act(async () => {
    failAcquire(new Error("new acquisition failed"))
    await acquire
  })
  expect(onLeaseChange).toHaveBeenCalledTimes(1)
  expect(onLeaseChange).toHaveBeenCalledWith(null)
})

test("a monitored healthy observer captures once, supports manual refresh and captures immediately on fallback", async () => {
  const { result, rerender } = renderHook(
    ({ healthy }) =>
      useSandboxDesktop("c1", true, undefined, true, {
        streaming: true,
        streamHealthy: healthy,
      }),
    { initialProps: { healthy: true } }
  )
  await tick()
  for (let i = 0; i < 12; i++) await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(1)
  await act(async () => {
    await result.current.refresh()
  })
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
  rerender({ healthy: false })
  await tick()
  expect(client.desktopFrame).toHaveBeenCalledTimes(3)
  expect(client.acquireControl).not.toHaveBeenCalled()
  expect(client.releaseControl).not.toHaveBeenCalled()
})

test("healthy video retains fresh takeover proofs, controller captures and lease renewal", async () => {
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true, streamHealthy: true })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
  expect(result.current.controlling).toBe(true)
  await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(3)
  expect(client.renewControl).toHaveBeenCalledWith("c1", "lease", 2)
  await act(async () => {
    await result.current.release()
  })
  for (let i = 0; i < 12; i++) await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(3)
  expect(client.releaseControl).toHaveBeenCalledWith("c1", "lease", 2)
})

test("healthy media retries failed observer priming before suppressing periodic captures", async () => {
  client.desktopFrame.mockRejectedValueOnce(new Error("initial capture unavailable"))
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true, streamHealthy: true })
  )
  await tick()
  expect(result.current.frame).toBeNull()
  await tick(5000)
  expect(result.current.frame).toEqual(frame)
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
  for (let i = 0; i < 12; i++) await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
})

test("renews human control and releases on blur", async () => {
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  expect(result.current.controlling).toBe(true)
  await act(async () => {
    expect(await result.current.input({ kind: "typeText", text: "中文" }, null, 42)).toBe(true)
  })
  await tick(5000)
  expect(client.acquireControl).toHaveBeenCalledWith("c1", true)
  expect(client.controlInput).toHaveBeenCalledWith("c1", "lease", 2, "f2", null, {
    kind: "typeText",
    text: "中文",
  })
  expect(client.renewControl).toHaveBeenCalledWith("c1", "lease", 2)
  await act(async () => {
    window.dispatchEvent(new Event("blur"))
  })
  await tick()
  expect(result.current.controlling).toBe(false)
  expect(client.releaseControl).toHaveBeenCalledWith("c1", "lease", 2)
})

test("while streaming it polls slowly, reports the lease, and keeps control when focus enters the stream", async () => {
  const onLeaseChange = jest.fn()
  const frameElement = document.createElement("iframe")
  frameElement.dataset.sandboxStream = "c1"
  document.body.appendChild(frameElement)
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true, onLeaseChange })
  )
  await tick()
  await tick(1000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(1)
  await tick(4000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
  await act(async () => {
    await result.current.acquire()
  })
  expect(onLeaseChange).toHaveBeenLastCalledWith(expect.objectContaining({ token: "lease" }))
  const hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(true)
  frameElement.focus()
  await act(async () => {
    window.dispatchEvent(new Event("blur"))
  })
  await tick()
  expect(result.current.controlling).toBe(true)
  expect(client.releaseControl).not.toHaveBeenCalled()
  // Leaving the app entirely still gives control back.
  hasFocus.mockReturnValue(false)
  await act(async () => {
    window.dispatchEvent(new Event("blur"))
  })
  await tick()
  expect(result.current.controlling).toBe(false)
  expect(onLeaseChange).toHaveBeenLastCalledWith(null)
  hasFocus.mockRestore()
  frameElement.remove()
})

test("on the desktop, focus in the stream keeps control even though WebKit reports no focus", async () => {
  const frameElement = document.createElement("iframe")
  frameElement.dataset.sandboxStream = "c1"
  document.body.appendChild(frameElement)
  document.documentElement.dataset.windowFocused = "true"
  // WKWebView: the parent document has no focus while its cross-origin child does.
  const hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(false)
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  frameElement.focus()
  await act(async () => {
    window.dispatchEvent(new Event("blur"))
  })
  await tick()
  expect(result.current.controlling).toBe(true)
  expect(client.releaseControl).not.toHaveBeenCalled()
  // The app going to the background fires no blur here; the native window does.
  await act(async () => {
    document.documentElement.dataset.windowFocused = "false"
    await Promise.resolve()
  })
  await tick()
  expect(result.current.controlling).toBe(false)
  expect(client.releaseControl).toHaveBeenCalledTimes(1)
  hasFocus.mockRestore()
  frameElement.remove()
  delete document.documentElement.dataset.windowFocused
})

test("releases a late lease after unmount instead of retaining invisible control", async () => {
  let resolve!: (lease: { token: string; fence: number; expiresAt: number }) => void
  client.acquireControl.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const { result, unmount } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  act(() => {
    void result.current.acquire()
  })
  unmount()
  await act(async () => {
    resolve({ token: "late", fence: 9, expiresAt: Date.now() + 15000 })
  })
  expect(client.releaseControl).toHaveBeenCalledWith("c1", "late", 9)
})

test("capture failures clear stale pixels, release control, and recover automatically", async () => {
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  client.desktopFrame.mockRejectedValueOnce(new Error("offline"))
  await tick(1000)
  expect(result.current.frame).toBeNull()
  expect(result.current.controlling).toBe(false)
  expect(result.current.error).toBe("capture")
  await tick(1000)
  expect(result.current.frame).toEqual(frame)
  expect(result.current.error).toBeNull()
})

test("an auxiliary screenshot failure keeps a streaming lease but clears native input proofs", async () => {
  const onLeaseChange = jest.fn()
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true, onLeaseChange })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  client.desktopFrame.mockRejectedValueOnce(new Error("screenshot transport unavailable"))
  await tick(5000)
  expect(result.current.frame).toBeNull()
  expect(result.current.controlling).toBe(true)
  expect(result.current.error).toBe("capture")
  expect(client.releaseControl).not.toHaveBeenCalled()
  expect(onLeaseChange).not.toHaveBeenCalledWith(null)
  expect(client.renewControl).toHaveBeenCalled()
  expect(await result.current.input({ kind: "click" }, { x: 1, y: 2 }, 42)).toBe(false)
  expect(client.controlInput).not.toHaveBeenCalled()
  await tick(5000)
  expect(result.current.frame).toEqual(frame)
  expect(result.current.error).toBeNull()
  expect(result.current.controlling).toBe(true)
  await act(async () => {
    await result.current.release()
  })
  expect(client.releaseControl).toHaveBeenCalledTimes(1)
  expect(onLeaseChange).toHaveBeenLastCalledWith(null)
})

test("a streaming frame with the wrong fence still releases control", async () => {
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  client.desktopFrame.mockImplementationOnce(async () => ({ ...proofFor(), fence: fence + 1 }))
  await tick(5000)
  expect(result.current.controlling).toBe(false)
  expect(client.releaseControl).toHaveBeenCalledTimes(1)
  expect(result.current.frame).toBeNull()
})

test("streaming screenshot failures do not prevent lease loss from releasing control", async () => {
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  client.desktopFrame.mockRejectedValue(new Error("capture failed"))
  await tick(5000)
  expect(result.current.controlling).toBe(true)
  client.renewControl.mockRejectedValueOnce(new Error("lease revoked"))
  await tick(5000)
  expect(result.current.controlling).toBe(false)
  expect(client.releaseControl).toHaveBeenCalledTimes(1)
})

test("a streaming lease still expires when auxiliary captures fail and renewal hangs", async () => {
  let completeRenewal!: (lease: { token: string; fence: number; expiresAt: number }) => void
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  client.desktopFrame.mockRejectedValue(new Error("capture unavailable"))
  client.renewControl.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeRenewal = resolve
      })
  )
  await tick(5000)
  expect(result.current.controlling).toBe(true)
  await tick(10000)
  expect(result.current.controlling).toBe(false)
  expect(client.releaseControl).toHaveBeenCalledTimes(1)
  await act(async () => {
    completeRenewal({ token: "lease", fence, expiresAt: Date.now() + 15000 })
  })
  expect(result.current.controlling).toBe(false)
  expect(await result.current.input({ kind: "click" }, { x: 1, y: 2 }, 42)).toBe(false)
})

test("blur releases a streaming lease even after an auxiliary capture failure", async () => {
  const { result } = renderHook(() =>
    useSandboxDesktop("c1", true, undefined, true, { streaming: true })
  )
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  client.desktopFrame.mockRejectedValueOnce(new Error("capture unavailable"))
  await tick(5000)
  expect(result.current.controlling).toBe(true)
  await act(async () => {
    window.dispatchEvent(new Event("blur"))
  })
  await tick()
  expect(result.current.controlling).toBe(false)
  expect(client.releaseControl).toHaveBeenCalledTimes(1)
})

test("no overlapping capture requests or work on disabled connections", async () => {
  client.desktopFrame.mockImplementationOnce(() => new Promise(() => {}))
  const { result, rerender } = renderHook(({ enabled }) => useSandboxDesktop("c1", enabled), {
    initialProps: { enabled: true },
  })
  await tick()
  await tick(5000)
  await act(async () => {
    await result.current.refresh()
  })
  expect(client.desktopFrame).toHaveBeenCalledTimes(1)
  rerender({ enabled: false })
  await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(1)
})

test("rejects stale frame inputs and releases control after renewal failure", async () => {
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  expect(await result.current.input({ kind: "click" }, { x: 0, y: 0 }, 41)).toBe(false)
  client.renewControl.mockRejectedValueOnce(new Error("expired"))
  await tick(5000)
  expect(result.current.controlling).toBe(false)
  expect(result.current.error).toBe("control")
  expect(client.controlInput).not.toHaveBeenCalled()
})

test("a queued keystroke cannot reuse a consumed proof; the next frame enables it", async () => {
  let completeFirst!: () => void
  client.controlInput.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeFirst = resolve
      })
  )
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  const first = result.current.input({ kind: "typeText", text: "a" }, null, 42)
  const second = result.current.input({ kind: "typeText", text: "b" }, null, 42)
  client.desktopFrame.mockImplementation(async () => proofFor({ ...frame, capturedAt: 43 }))
  await tick()
  await act(async () => {
    completeFirst()
    expect(await first).toBe(true)
    expect(await second).toBe(false)
  })
  expect(client.controlInput).toHaveBeenCalledTimes(1)
  expect(result.current.frame?.capturedAt).toBe(43)
  expect(result.current.controlling).toBe(true)
  await act(async () => {
    expect(await result.current.input({ kind: "typeText", text: "b" }, null, 43)).toBe(true)
  })
  expect(client.controlInput).toHaveBeenLastCalledWith("c1", "lease", 2, "f3", null, {
    kind: "typeText",
    text: "b",
  })
})

test("queued pointer input is rejected if a capture changes desktop dimensions", async () => {
  let completeFirst!: () => void
  client.controlInput.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeFirst = resolve
      })
  )
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  const first = result.current.input({ kind: "typeText", text: "a" }, null, 42)
  const second = result.current.input({ kind: "click" }, { x: 10, y: 10 }, 42)
  client.desktopFrame.mockImplementation(async () =>
    proofFor({ ...frame, width: 400, capturedAt: 43 })
  )
  await tick(1000)
  await act(async () => {
    completeFirst()
    await first
    expect(await second).toBe(false)
  })
  expect(client.controlInput).toHaveBeenCalledTimes(1)
})

test("client-local capture and control continue without an external network", async () => {
  const online = jest.spyOn(navigator, "onLine", "get").mockReturnValue(false)
  try {
    const { result } = renderHook(() => useSandboxDesktop("c1", true))
    await tick()
    expect(result.current.frame).toEqual(frame)
    await act(async () => {
      await result.current.acquire()
    })
    window.dispatchEvent(new Event("offline"))
    await tick(1000)
    expect(result.current.controlling).toBe(true)
    // Initial observation, the fresh controller frame at acquisition, one poll.
    expect(client.desktopFrame).toHaveBeenCalledTimes(3)
    expect(client.releaseControl).not.toHaveBeenCalled()
  } finally {
    online.mockRestore()
  }
})

function managedSession() {
  let invalidated: (() => void) | undefined
  const status = {
    qualified: true,
    state: "observer" as const,
    controllerKind: null,
    controllerIsSelf: false,
    leaseExpiresAt: null,
    fence: 1,
    canAcquire: true,
    agentControlDormant: true as const,
  }
  const proof = { screenshot: frame, frameId: "observer", fence: 1, expiresAt: Date.now() + 5000 }
  return {
    managed: true,
    status: jest.fn().mockResolvedValue(status),
    frame: jest.fn().mockResolvedValue(proof),
    acquire: jest
      .fn()
      .mockResolvedValue({ token: "managed", fence: 2, expiresAt: Date.now() + 15000 }),
    renew: jest
      .fn()
      .mockResolvedValue({ token: "managed", fence: 2, expiresAt: Date.now() + 15000 }),
    release: jest.fn().mockResolvedValue(undefined),
    input: jest.fn().mockResolvedValue(undefined),
    onInvalidated: (handler: () => void) => {
      invalidated = handler
      return () => {
        invalidated = undefined
      }
    },
    close: jest.fn(),
    invalidate: () => invalidated?.(),
  }
}

test("managed sessions retain status checks and capture polling despite healthy media options", async () => {
  const desktop = managedSession()
  desktop.frame.mockImplementation(async () => proofFor())
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() =>
    useSandboxDesktop("cloud", true, open, true, { streaming: true, streamHealthy: true })
  )
  await tick()
  await tick(5000)
  await tick(5000)
  // Qualification is checked before the initial stream attempt and again
  // when that attempt rejects, before falling back to single-frame RPC.
  expect(desktop.status).toHaveBeenCalledTimes(4)
  expect(desktop.frame).toHaveBeenCalledTimes(3)
  expect(result.current.frame).toEqual(frame)
  expect(desktop.acquire).not.toHaveBeenCalled()
})

test("managed acquisition requires a fresh fenced frame before enabling input", async () => {
  const desktop = managedSession()
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() => useSandboxDesktop("cloud", true, open))
  await tick()
  let complete!: (proof: unknown) => void
  desktop.frame.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  act(() => {
    void result.current.acquire()
  })
  await tick()
  expect(result.current.controlling).toBe(false)
  expect(result.current.frame).toBeNull()
  expect(await result.current.input({ kind: "click" }, { x: 1, y: 1 }, 42)).toBe(false)
  await act(async () => {
    complete({ screenshot: frame, frameId: "fresh", fence: 2, expiresAt: Date.now() + 5000 })
  })
  expect(result.current.controlling).toBe(true)
  await act(async () => {
    expect(await result.current.input({ kind: "click" }, { x: 1, y: 1 }, 42)).toBe(true)
  })
  expect(desktop.input).toHaveBeenCalledWith(
    expect.objectContaining({ fence: 2 }),
    expect.objectContaining({ frameId: "fresh" }),
    { x: 1, y: 1 },
    { kind: "click" }
  )
  expect(client.controlInput).not.toHaveBeenCalled()
})

test("managed invalidation drops queued input and never resumes control on reconnect", async () => {
  const desktop = managedSession()
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() => useSandboxDesktop("cloud", true, open))
  await tick()
  desktop.frame.mockResolvedValue({
    screenshot: frame,
    frameId: "fresh",
    fence: 2,
    expiresAt: Date.now() + 5000,
  })
  await act(async () => {
    await result.current.acquire()
  })
  let complete!: () => void
  desktop.input.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () => resolve(undefined)
      })
  )
  const first = result.current.input({ kind: "typeText", text: "a" }, null, 42)
  const queued = result.current.input({ kind: "typeText", text: "b" }, null, 42)
  await tick()
  await act(async () => {
    desktop.invalidate()
  })
  await act(async () => {
    complete()
    await first
    expect(await queued).toBe(false)
  })
  expect(result.current.frame).toBeNull()
  expect(result.current.controlling).toBe(false)
  expect(desktop.input).toHaveBeenCalledTimes(1)
  await act(async () => {
    window.dispatchEvent(new Event("online"))
  })
  await tick(1000)
  expect(desktop.acquire).toHaveBeenCalledTimes(1)
})

test("managed unqualified status never captures or acquires", async () => {
  const desktop = managedSession()
  desktop.status.mockResolvedValue({ qualified: false, state: "dormant", canAcquire: false })
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() => useSandboxDesktop("cloud", true, open))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  expect(desktop.frame).not.toHaveBeenCalled()
  expect(desktop.acquire).not.toHaveBeenCalled()
  expect(result.current.status?.state).toBe("dormant")
})

test("managed transport replacement releases a late lease on the original session", async () => {
  const first = managedSession()
  const second = managedSession()
  const openFirst = jest.fn().mockResolvedValue(first)
  const openSecond = jest.fn().mockResolvedValue(second)
  let complete!: (lease: unknown) => void
  first.acquire.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const { result, rerender } = renderHook(({ open }) => useSandboxDesktop("cloud", true, open), {
    initialProps: { open: openFirst },
  })
  await tick()
  act(() => {
    void result.current.acquire()
  })
  rerender({ open: openSecond })
  await tick()
  await act(async () => {
    complete({ token: "late", fence: 9, expiresAt: Date.now() + 15000 })
  })
  expect(first.release).toHaveBeenCalledWith(expect.objectContaining({ token: "late", fence: 9 }))
  expect(second.release).not.toHaveBeenCalled()
  expect(result.current.controlling).toBe(false)
})

test("mobile managed observer cannot acquire even when Host permits it", async () => {
  const desktop = managedSession()
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() => useSandboxDesktop("cloud", true, open, false))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  expect(result.current.frame).toEqual(frame)
  expect(desktop.acquire).not.toHaveBeenCalled()
})

test("managed expiry releases control and requires a new gesture after observation recovers", async () => {
  const desktop = managedSession()
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() => useSandboxDesktop("cloud", true, open))
  await tick()
  desktop.frame.mockImplementation(async () => ({
    screenshot: frame,
    frameId: "fresh",
    fence: 2,
    expiresAt: Date.now() + 5000,
  }))
  desktop.status.mockResolvedValue({
    qualified: true,
    state: "controlled",
    controllerKind: "human",
    controllerIsSelf: true,
    fence: 2,
    canAcquire: false,
  })
  desktop.renew.mockImplementationOnce(() => new Promise(() => {}))
  await act(async () => {
    await result.current.acquire()
  })
  await tick(5000)
  await tick(10000)
  expect(result.current.controlling).toBe(false)
  expect(desktop.release).toHaveBeenCalled()
  desktop.status.mockResolvedValue({
    qualified: true,
    state: "observer",
    controllerKind: null,
    controllerIsSelf: false,
    fence: 3,
    canAcquire: true,
  })
  await tick(1000)
  expect(result.current.status?.canAcquire).toBe(true)
  expect(desktop.acquire).toHaveBeenCalledTimes(1)
  desktop.acquire.mockResolvedValueOnce({ token: "next", fence: 3, expiresAt: Date.now() + 15000 })
  desktop.frame.mockImplementation(async () => ({
    screenshot: frame,
    frameId: "next",
    fence: 3,
    expiresAt: Date.now() + 5000,
  }))
  await act(async () => {
    await result.current.acquire()
  })
  expect(result.current.controlling).toBe(true)
  expect(desktop.acquire).toHaveBeenCalledTimes(2)
})

test("managed frame proof is single use and new pixels enable the next input", async () => {
  const desktop = managedSession()
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() => useSandboxDesktop("cloud", true, open))
  await tick()
  desktop.frame.mockResolvedValue({
    screenshot: frame,
    frameId: "one",
    fence: 2,
    expiresAt: Date.now() + 5000,
  })
  await act(async () => {
    await result.current.acquire()
  })
  desktop.status.mockResolvedValue({
    qualified: true,
    state: "controlled",
    controllerKind: "human",
    controllerIsSelf: true,
    fence: 2,
    canAcquire: false,
  })
  let finish!: () => void
  desktop.input.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined)
      })
  )
  const first = result.current.input({ kind: "click" }, { x: 1, y: 1 }, 42)
  const queued = result.current.input({ kind: "click" }, { x: 2, y: 2 }, 42)
  await tick()
  expect(desktop.input).toHaveBeenCalledTimes(1)
  const nextFrame = { ...frame, capturedAt: 43 }
  desktop.frame.mockResolvedValue({
    screenshot: nextFrame,
    frameId: "two",
    fence: 2,
    expiresAt: Date.now() + 5000,
  })
  await act(async () => {
    finish()
    expect(await first).toBe(true)
    expect(await queued).toBe(false)
  })
  expect(result.current.controlling).toBe(true)
  expect(desktop.release).not.toHaveBeenCalled()
  expect(result.current.frame).toEqual(nextFrame)
  await act(async () => {
    expect(await result.current.input({ kind: "click" }, { x: 3, y: 3 }, 43)).toBe(true)
  })
  expect(desktop.input).toHaveBeenCalledTimes(2)
  expect(desktop.input).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ frameId: "two" }),
    { x: 3, y: 3 },
    { kind: "click" }
  )
})

test("capture started before a managed mutation cannot restore a consumed proof", async () => {
  const desktop = managedSession()
  const open = jest.fn().mockResolvedValue(desktop)
  const { result } = renderHook(() => useSandboxDesktop("cloud", true, open))
  await tick()
  desktop.frame.mockResolvedValue({
    screenshot: frame,
    frameId: "one",
    fence: 2,
    expiresAt: Date.now() + 5000,
  })
  await act(async () => {
    await result.current.acquire()
  })
  desktop.status.mockResolvedValue({
    qualified: true,
    state: "controlled",
    controllerKind: "human",
    controllerIsSelf: true,
    fence: 2,
    canAcquire: false,
  })
  let staleCapture!: (proof: unknown) => void
  desktop.frame.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        staleCapture = resolve
      })
  )
  await tick(1000)
  await act(async () => {
    expect(await result.current.input({ kind: "click" }, { x: 1, y: 1 }, 42)).toBe(true)
  })
  const fresh = { ...frame, capturedAt: 44 }
  desktop.frame.mockResolvedValue({
    screenshot: fresh,
    frameId: "three",
    fence: 2,
    expiresAt: Date.now() + 5000,
  })
  await act(async () => {
    staleCapture({
      screenshot: { ...frame, capturedAt: 43 },
      frameId: "stale",
      fence: 2,
      expiresAt: Date.now() + 5000,
    })
  })
  expect(result.current.frame?.capturedAt).not.toBe(43)
  expect(await result.current.input({ kind: "click" }, { x: 2, y: 2 }, 42)).toBe(false)
  await tick()
  expect(result.current.frame).toEqual(fresh)
  expect(result.current.controlling).toBe(true)
  expect(desktop.input).toHaveBeenCalledTimes(1)
  expect(desktop.release).not.toHaveBeenCalled()
})
