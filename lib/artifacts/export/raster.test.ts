/** @jest-environment jsdom */
const html2canvasMock = jest.fn()
jest.mock("html2canvas-pro", () => ({
  __esModule: true,
  default: (...args: unknown[]) => html2canvasMock(...args),
}))

import {
  ArtifactNotRasterisableError,
  ArtifactPreviewNotMountedError,
  ArtifactRenderTimeoutError,
  ArtifactTooLargeToRasteriseError,
  DEFAULT_CAPTURE_VIEWPORT,
  MAX_PNG_HEIGHT_PX,
  MIN_CAPTURE_WIDTH_PX,
  captureArtifactToPngBlob,
  readAsDataUrl,
  renderArtifactToPngBlob,
} from "./raster"
import { registerArtifactRenderer } from "@/lib/artifacts/renderer-registry"
import {
  ArtifactPreviewOutdatedError,
  clearArtifactPreviewNodes,
  registerArtifactPreviewNode,
} from "@/lib/artifacts/preview-registry"
import {
  registerArtifactFrameCapturer,
  __resetArtifactFrameCapturersForTests,
} from "@/lib/artifacts/frame-capture-registry"

/** The off-screen capture frame, once the exporter has created it. */
function captureFrame(): Promise<HTMLIFrameElement> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const found = document.querySelector("iframe") as HTMLIFrameElement | null
      if (found) {
        clearInterval(poll)
        resolve(found)
      }
    }, 0)
  })
}

/** A live (scripted) frame registration answering with `html`. */
function liveFrame(content: string, html: string, height = 400) {
  return {
    live: true,
    shows: () => content,
    capture: async () => ({ html, width: 900, height }),
  }
}

function fakeCanvas(blob: Blob | null = new Blob(["png"], { type: "image/png" })) {
  return {
    toBlob: (cb: (b: Blob | null) => void) => cb(blob),
  } as unknown as HTMLCanvasElement
}

beforeEach(() => {
  html2canvasMock.mockReset().mockResolvedValue(fakeCanvas())
  clearArtifactPreviewNodes()
  __resetArtifactFrameCapturersForTests()
  document.body.innerHTML = ""
})

describe("renderArtifactToPngBlob — renderer transports", () => {
  const chart = { id: "a1", type: "chart" as const, content: "{}" }

  it("captures the mounted preview node", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    registerArtifactPreviewNode("a1", node, () => chart.content)

    const blob = await renderArtifactToPngBlob(chart)

    expect(blob.type).toBe("image/png")
    expect(html2canvasMock).toHaveBeenCalledWith(node, expect.objectContaining({ scale: 2 }))
  })

  it("refuses with a typed error when the preview is not mounted", async () => {
    // Recharts draws live React; with nothing on screen there are no pixels.
    // "Preview it first" and "too large" are different user problems, so they
    // must not collapse into one opaque failure.
    await expect(renderArtifactToPngBlob(chart)).rejects.toBeInstanceOf(
      ArtifactPreviewNotMountedError
    )
    expect(html2canvasMock).not.toHaveBeenCalled()
  })

  it("treats a detached node as not mounted", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    registerArtifactPreviewNode("a1", node, () => chart.content)
    node.remove()
    await expect(renderArtifactToPngBlob(chart)).rejects.toBeInstanceOf(
      ArtifactPreviewNotMountedError
    )
  })

  it("refuses a node taller than a canvas can hold", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    Object.defineProperty(node, "scrollHeight", { value: MAX_PNG_HEIGHT_PX + 1 })
    registerArtifactPreviewNode("a1", node, () => chart.content)
    await expect(renderArtifactToPngBlob(chart)).rejects.toBeInstanceOf(
      ArtifactTooLargeToRasteriseError
    )
  })

  it("surfaces a null toBlob rather than resolving an empty file", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    registerArtifactPreviewNode("a1", node, () => chart.content)
    html2canvasMock.mockResolvedValue(fakeCanvas(null))
    await expect(renderArtifactToPngBlob(chart)).rejects.toThrow("toBlob")
  })
})

describe("renderArtifactToPngBlob — iframe transports", () => {
  it("captures html through an off-screen frame, not the sandboxed preview", async () => {
    // html2canvas walks the DOM and cannot reach into the preview's sandboxed
    // frame (`allow-scripts`, no `allow-same-origin`), which is why this
    // indirection exists at all.
    const promise = renderArtifactToPngBlob({
      id: "a2",
      type: "html",
      content: "<p>hello</p>",
    })
    const frame = await captureFrame()
    expect(frame).not.toBeNull()
    expect(frame.getAttribute("sandbox")).toBeNull()
    frame.dispatchEvent(new Event("load"))

    const blob = await promise
    expect(blob.type).toBe("image/png")
    // …and the scratch frame is cleaned up.
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("removes the scratch frame even when the capture throws", async () => {
    html2canvasMock.mockRejectedValue(new Error("boom"))
    const promise = renderArtifactToPngBlob({ id: "a2", type: "html", content: "<p>x</p>" })
    ;(await captureFrame()).dispatchEvent(new Event("load"))
    await expect(promise).rejects.toThrow("boom")
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("strips scripts from the captured html", async () => {
    const promise = renderArtifactToPngBlob({
      id: "a2",
      type: "html",
      content: "<p>ok</p><script>fetch('https://evil.test')</script>",
    })
    const frame = await captureFrame()
    // The frame is deliberately NOT sandboxed so html2canvas can read it;
    // sanitisation is what makes that safe.
    expect(frame.srcdoc).not.toContain("<script")
    frame.dispatchEvent(new Event("load"))
    await promise
  })
})

describe("renderArtifactToPngBlob — what the preview shows (C07, C08)", () => {
  it("captures interactive HTML as its scripts left it, not as it loaded", async () => {
    // The sandboxed frame had turned the box green; the source still says red.
    const content = '<div id="box" style="background:red">box</div><script>go()</script>'
    registerArtifactFrameCapturer(
      "h1",
      liveFrame(
        content,
        '<!DOCTYPE html><html><body><div style="background:green">box</div></body></html>'
      )
    )
    const promise = renderArtifactToPngBlob({ id: "h1", type: "html", content })
    const frame = await captureFrame()
    expect(frame.srcdoc).toContain("background:green")
    expect(frame.srcdoc).not.toContain("background:red")
    frame.dispatchEvent(new Event("load"))
    await promise
  })

  it("keeps the controls a live frame drew, which the source profile strips", async () => {
    const content = "export default function App(){ return <button>Go</button> }"
    registerArtifactFrameCapturer(
      "r2",
      liveFrame(
        content,
        '<!DOCTYPE html><html><body><button autofocus onclick="x()">Go</button><input value="typed"><script>bad()</script></body></html>'
      )
    )
    const promise = renderArtifactToPngBlob({ id: "r2", type: "react", content })
    const frame = await captureFrame()
    expect(frame.srcdoc).toContain("<button>Go</button>")
    expect(frame.srcdoc).toContain('value="typed"')
    expect(frame.srcdoc).not.toContain("<script")
    expect(frame.srcdoc).not.toContain("onclick")
    expect(frame.srcdoc).not.toContain("autofocus")
    frame.dispatchEvent(new Event("load"))
    await promise
  })

  it("re-renders static HTML from source, as its passive preview draws it", async () => {
    // A passive frame registers too, but is not live: its source is the truth.
    registerArtifactFrameCapturer("h2", {
      live: false,
      shows: () => "<p>static</p><button>x</button>",
      capture: async () => {
        throw new Error("a passive frame is never asked")
      },
    })
    const promise = renderArtifactToPngBlob({
      id: "h2",
      type: "html",
      content: "<p>static</p><button>x</button>",
    })
    const frame = await captureFrame()
    expect(frame.srcdoc).toContain("static")
    expect(frame.srcdoc).not.toContain("<button")
    frame.dispatchEvent(new Event("load"))
    await promise
  })

  it("captures a scrolling renderer whole, whatever its scroll position", async () => {
    const chart = { id: "s1", type: "chart" as const, content: "{}" }
    const node = document.createElement("div")
    node.style.overflow = "auto"
    node.style.height = "120px"
    const inner = document.createElement("div")
    inner.style.overflowY = "scroll"
    inner.style.maxHeight = "40px"
    node.appendChild(inner)
    document.body.appendChild(node)
    registerArtifactPreviewNode("s1", node, () => chart.content)

    await renderArtifactToPngBlob(chart)

    const [, options] = html2canvasMock.mock.calls[0] as [
      HTMLElement,
      { onclone: (doc: Document, clone: HTMLElement) => void },
    ]
    // Run the hook on a copy, as html2canvas would on its clone.
    const clone = node.cloneNode(true) as HTMLElement
    document.body.appendChild(clone)
    clone.scrollTop = 30
    options.onclone(document, clone)
    for (const element of [clone, clone.firstElementChild as HTMLElement]) {
      expect(element.style.getPropertyValue("overflow")).toBe("visible")
      expect(element.style.getPropertyValue("height")).toBe("auto")
      expect(element.style.getPropertyValue("max-height")).toBe("none")
    }
    expect(clone.scrollTop).toBe(0)
  })

  it("refuses a renderer showing another revision than the one requested (C08)", async () => {
    jest.useFakeTimers()
    try {
      const node = document.createElement("div")
      document.body.appendChild(node)
      registerArtifactPreviewNode("c1", node, () => "v2")
      const pending = renderArtifactToPngBlob({ id: "c1", type: "chart", content: "v1" })
      const assertion = expect(pending).rejects.toBeInstanceOf(ArtifactPreviewOutdatedError)
      await jest.advanceTimersByTimeAsync(2_000)
      await assertion
      expect(html2canvasMock).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("refuses when the node repaints between finding it and copying it", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    const shown = ["v1", "v2"]
    registerArtifactPreviewNode("c2", node, () => shown.shift() ?? "v2")
    await expect(
      renderArtifactToPngBlob({ id: "c2", type: "chart", content: "v1" })
    ).rejects.toBeInstanceOf(ArtifactPreviewOutdatedError)
    expect(html2canvasMock).not.toHaveBeenCalled()
  })

  it("never answers for one revision with a frame showing another", async () => {
    jest.useFakeTimers()
    try {
      registerArtifactFrameCapturer("r3", liveFrame("v2", "<html>v2</html>"))
      const pending = renderArtifactToPngBlob({ id: "r3", type: "react", content: "v1" })
      const assertion = expect(pending).rejects.toBeInstanceOf(ArtifactPreviewOutdatedError)
      await jest.advanceTimersByTimeAsync(2_000)
      await assertion
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("renderArtifactToPngBlob — unsupported transports", () => {
  it("refuses a jupyter artifact, which has no rendered form here", async () => {
    await expect(
      renderArtifactToPngBlob({ id: "a3", type: "jupyter", content: "{}" })
    ).rejects.toBeInstanceOf(ArtifactNotRasterisableError)
  })
})

describe("renderArtifactToPngBlob — react", () => {
  const snapshot = (html: string, height = 400) => ({ html, width: 900, height })

  it("captures what the live frame drew, not the unexecuted source", async () => {
    // The artifact's own content is JSX that has not run, so re-rendering it
    // off-screen would produce a blank image. The snapshot is the whole point.
    const content = "export default function App(){ return <h1>drawn</h1> }"
    registerArtifactFrameCapturer(
      "r1",
      liveFrame(content, snapshot("<!DOCTYPE html><html><body><h1>drawn</h1></body></html>").html)
    )
    const promise = renderArtifactToPngBlob({ id: "r1", type: "react", content })
    const frame = await captureFrame()
    expect(frame.srcdoc).toContain("drawn")
    expect(frame.srcdoc).not.toContain("export default")
    frame.dispatchEvent(new Event("load"))
    expect((await promise).type).toBe("image/png")
  })

  it("says the preview must be open rather than exporting a blank image", async () => {
    await expect(
      renderArtifactToPngBlob({ id: "r1", type: "react", content: "x" })
    ).rejects.toBeInstanceOf(ArtifactPreviewNotMountedError)
  })

  it("refuses a snapshot taller than a canvas can hold", async () => {
    registerArtifactFrameCapturer("r1", liveFrame("x", "<html></html>", MAX_PNG_HEIGHT_PX + 1))
    await expect(
      renderArtifactToPngBlob({ id: "r1", type: "react", content: "x" })
    ).rejects.toBeInstanceOf(ArtifactTooLargeToRasteriseError)
  })
})

describe("captureArtifactToPngBlob — plugin renderers", () => {
  const artifact = {
    id: "wb1",
    sessionId: "s1",
    messageId: "m1",
    type: "code" as const,
    title: "Workbook",
    content: "{}",
    language: "json" as const,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: { plugin: { kind: "demo/sheet", schemaVersion: 1, ownerPluginId: "demo" } },
  }
  let dispose: () => void

  afterEach(() => dispose?.())

  function register(ready?: () => Promise<void>) {
    const events: string[] = []
    const mounted: HTMLElement[] = []
    dispose = registerArtifactRenderer("demo/sheet", {
      id: "demo/sheet",
      kind: "demo/sheet",
      mount: (_artifact, container) => {
        events.push("mount")
        mounted.push(container)
        container.textContent = "grid"
        return {
          ...(ready ? { ready } : {}),
          dispose: () => {
            events.push("dispose")
            container.replaceChildren()
          },
        }
      },
    })
    return { events, mounted }
  }

  it("mounts off-screen at the requested viewport, waits for ready, and cleans up", async () => {
    let finishPaint: () => void = () => {}
    const painted = new Promise<void>((resolve) => {
      finishPaint = resolve
    })
    const { events, mounted } = register(() => painted)
    const pending = captureArtifactToPngBlob(artifact, { width: 10, height: 99_999 })
    await Promise.resolve()
    expect(html2canvasMock).not.toHaveBeenCalled()
    const container = mounted[0]
    // Clamped to the capture bounds, and out of sight but not hidden.
    expect(container.style.width).toBe(`${MIN_CAPTURE_WIDTH_PX}px`)
    expect(container.style.height).toBe(`${MAX_PNG_HEIGHT_PX}px`)
    expect(container.style.left).toBe("-100000px")
    expect(container.getAttribute("aria-hidden")).toBe("true")
    finishPaint()
    const blob = await pending
    expect(blob.type).toBe("image/png")
    const [target, options] = html2canvasMock.mock.calls[0]
    expect(target).toBe(container)
    expect(options).toMatchObject({ scale: 1, x: 0, y: 0, width: MIN_CAPTURE_WIDTH_PX })
    // The clone is moved back on-screen so the crop at 0,0 contains it.
    const cloned = document.implementation.createHTMLDocument("")
    const clone = cloned.createElement("div")
    clone.id = container.id
    clone.style.left = "-100000px"
    cloned.body.appendChild(clone)
    options.onclone(cloned)
    expect(clone.style.left).toBe("0px")
    expect(events).toEqual(["mount", "dispose"])
    expect(container.isConnected).toBe(false)
  })

  it("defaults to the standard viewport when the renderer paints synchronously", async () => {
    register()
    await captureArtifactToPngBlob(artifact)
    expect(html2canvasMock.mock.calls[0][1]).toMatchObject({
      width: DEFAULT_CAPTURE_VIEWPORT.width,
      height: DEFAULT_CAPTURE_VIEWPORT.height,
    })
  })

  it("times out a renderer that never paints, and still disposes it", async () => {
    const { events } = register(() => new Promise<void>(() => {}))
    await expect(captureArtifactToPngBlob(artifact, { readyTimeoutMs: 5 })).rejects.toBeInstanceOf(
      ArtifactRenderTimeoutError
    )
    expect(events).toEqual(["mount", "dispose"])
    expect(html2canvasMock).not.toHaveBeenCalled()
  })

  it("falls back to the built-in transports without a plugin renderer", async () => {
    await expect(
      captureArtifactToPngBlob({ ...artifact, id: "c1", type: "chart", metadata: undefined })
    ).rejects.toBeInstanceOf(ArtifactPreviewNotMountedError)
  })
})

describe("readAsDataUrl", () => {
  it("encodes a blob as a data URL", async () => {
    await expect(readAsDataUrl(new Blob(["hi"], { type: "text/plain" }))).resolves.toBe(
      "data:text/plain;base64,aGk="
    )
  })
})
