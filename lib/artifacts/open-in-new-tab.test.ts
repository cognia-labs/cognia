/** @jest-environment jsdom */
import { createHash } from "node:crypto"
import { runInNewContext } from "node:vm"
import { createArtifactTabDocument } from "./open-in-new-tab"
import { grantInteractiveHtml } from "./interactive-grant"

const artifact = {
  id: "tab-html",
  type: "html" as const,
  title: '\"><script>title()</script>',
  content:
    '<html><body><p id="payload">Hello</p><button onclick="go()">Go</button><script>function go(){localStorage.clear()}</script></body></html>',
}

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: jest.fn(() => "blob:artifact-script"),
    revokeObjectURL: jest.fn(),
  })
})

function parse(html: string) {
  const outer = new DOMParser().parseFromString(html, "text/html")
  const frame = outer.querySelector("iframe")!
  expect(outer.querySelector("script, #payload, button, svg")).toBeNull()
  expect(outer.body.children).toHaveLength(1)
  expect(frame).not.toBeNull()
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
  const csp = outer
    .querySelector('meta[http-equiv="Content-Security-Policy"]')!
    .getAttribute("content")!
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("connect-src 'none'")
  expect(csp).toContain("form-action 'none'")
  expect(csp).toContain("base-uri 'none'")
  return { outer, frame, csp, inner: new DOMParser().parseFromString(frame.srcdoc, "text/html") }
}

it("B01 keeps HTML inert without the explicit per-artifact grant", () => {
  const tab = createArtifactTabDocument(artifact, true)
  const { frame, inner, csp } = parse(tab.html)
  expect(frame.getAttribute("sandbox")).toBe("")
  expect(csp).toContain("script-src 'none'")
  expect(inner.querySelector("#payload")?.textContent).toBe("Hello")
  expect(inner.querySelector("script, [onclick]")).toBeNull()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  tab.dispose()
})

it("B01 carries granted scripts as data with one hash-authorized bootstrap in the opaque frame", () => {
  const revoke = grantInteractiveHtml(artifact)
  try {
    const tab = createArtifactTabDocument(artifact, true)
    const { frame, inner, csp } = parse(tab.html)
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    const bootstrap = inner.querySelector('script:not([type="application/json"])')!
    const hash = createHash("sha256").update(bootstrap.textContent!).digest("base64")
    expect(csp).toContain(`script-src 'sha256-${hash}' blob:`)
    expect(
      inner.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")
    ).toBe(csp)
    expect(inner.querySelector("[onclick]")).toBeNull()
    expect(inner.querySelectorAll("script")).toHaveLength(2)
    expect(inner.querySelector("script[src]")).toBeNull()
    const scripts = JSON.parse(inner.querySelector('script[type="application/json"]')!.textContent!)
    expect(scripts).toHaveLength(2)
    expect(scripts[0]).toEqual({ code: "function go(){localStorage.clear()}" })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    tab.dispose()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    const otherTab = createArtifactTabDocument({ ...artifact, id: "other" }, true)
    expect(parse(otherTab.html).frame.getAttribute("sandbox")).toBe("")
    otherTab.dispose()
    const revisedTab = createArtifactTabDocument(
      { ...artifact, content: "<script>newCode()</script>" },
      true
    )
    expect(parse(revisedTab.html).frame.getAttribute("sandbox")).toBe("allow-scripts")
    revisedTab.dispose()
    const disabledTab = createArtifactTabDocument(artifact, false)
    expect(parse(disabledTab.html).frame.getAttribute("sandbox")).toBe("")
    disabledTab.dispose()
  } finally {
    revoke()
  }
})

it("B01 never executes SVG scripts, even if a grant exists", () => {
  const svg = {
    ...artifact,
    type: "svg" as const,
    content: '<svg onload="go()"><script>go()</script><rect width="10" height="10"/></svg>',
  }
  const revoke = grantInteractiveHtml(svg)
  try {
    const tab = createArtifactTabDocument(svg, true)
    const { inner, frame, csp } = parse(tab.html)
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(csp).toContain("script-src 'none'")
    expect(inner.querySelector("svg rect")).not.toBeNull()
    expect(inner.querySelector("script, [onload]")).toBeNull()
    tab.dispose()
  } finally {
    revoke()
  }
})

it("B01 escapes a srcdoc breakout and strips external scripts and nested frames", () => {
  const hostile = {
    ...artifact,
    content:
      '<p id="payload">\"&lt;/iframe&gt;</p><iframe srcdoc="&lt;script&gt;bad()&lt;/script&gt;"></iframe><script src="https://evil.test/x.js"></script>',
  }
  const revoke = grantInteractiveHtml(hostile)
  try {
    const tab = createArtifactTabDocument(hostile, true)
    const { inner } = parse(tab.html)
    expect(inner.querySelector("iframe, script[src]")).toBeNull()
    expect(
      JSON.parse(inner.querySelector('script[type="application/json"]')!.textContent!)
    ).toEqual([])
    tab.dispose()
  } finally {
    revoke()
  }
})

function prepareBootstrap() {
  const scripted = {
    ...artifact,
    content:
      '<p>Static</p><script>first()</script><script type="module">second()</script><script>third()</script>',
  }
  const revoke = grantInteractiveHtml(scripted)
  try {
    const { inner } = parse(createArtifactTabDocument(scripted, true).html)
    const bootstrap = inner.querySelector('script:not([type="application/json"])')!
    Object.defineProperty(inner, "currentScript", { value: bootstrap })
    return { inner, bootstrap: bootstrap.textContent! }
  } finally {
    revoke()
  }
}

it("creates and releases script blobs in the frame realm, retaining classic order and module flags", () => {
  const { inner, bootstrap } = prepareBootstrap()
  const frameUrl = { createObjectURL: jest.fn(), revokeObjectURL: jest.fn() }
  const blobs: BlobPart[][] = []
  class FrameBlob {
    constructor(parts: BlobPart[], options: BlobPropertyBag) {
      blobs.push(parts)
      expect(options).toEqual({ type: "text/javascript" })
    }
  }
  frameUrl.createObjectURL.mockImplementation(() => `blob:frame-${blobs.length}`)
  const page = new EventTarget()
  runInNewContext(bootstrap, {
    document: inner,
    URL: frameUrl,
    Blob: FrameBlob,
    addEventListener: page.addEventListener.bind(page),
  })
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(blobs).toEqual([["first()"], ["second()"], ["third()"]])
  const scripts = Array.from(inner.querySelectorAll<HTMLScriptElement>("script[src]"))
  expect(scripts.map((script) => script.src)).toEqual([
    "blob:frame-1",
    "blob:frame-2",
    "blob:frame-3",
  ])
  expect(scripts[0].async).toBe(false)
  expect(scripts[1].type).toBe("module")
  expect(scripts[2].async).toBe(false)
  scripts[0].dispatchEvent(new Event("load"))
  scripts[1].dispatchEvent(new Event("error"))
  expect(frameUrl.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1")
  expect(frameUrl.revokeObjectURL).toHaveBeenCalledWith("blob:frame-2")
  page.dispatchEvent(new Event("pagehide"))
  expect(frameUrl.revokeObjectURL).toHaveBeenCalledWith("blob:frame-3")
  expect(frameUrl.revokeObjectURL).toHaveBeenCalledTimes(3)
})

it("releases frame-created blobs if preparing a later script fails", () => {
  const { inner, bootstrap } = prepareBootstrap()
  const frameUrl = {
    createObjectURL: jest
      .fn()
      .mockReturnValueOnce("blob:first")
      .mockImplementationOnce(() => {
        throw new Error("blob failed")
      }),
    revokeObjectURL: jest.fn(),
  }
  expect(() =>
    runInNewContext(bootstrap, {
      document: inner,
      URL: frameUrl,
      Blob,
      addEventListener: jest.fn(),
    })
  ).toThrow("blob failed")
  expect(frameUrl.revokeObjectURL).toHaveBeenCalledWith("blob:first")
})

it("escapes JSON script terminators and HTML comment openers without changing compiled code", () => {
  const code = 'const text = "</script><script id=breakout>bad()</script><!--";'
  const hostile = { ...artifact, content: `<button onclick='${code}'>Go</button>` }
  const revoke = grantInteractiveHtml(hostile)
  try {
    const { inner } = parse(createArtifactTabDocument(hostile, true).html)
    const payload = inner.querySelector('script[type="application/json"]')!.textContent!
    expect(payload).not.toMatch(/<\/script|<!--/i)
    expect(inner.querySelector("#breakout")).toBeNull()
    expect(inner.querySelectorAll("script")).toHaveLength(2)
    expect(JSON.parse(payload)[0].code).toContain(code)
    expect(inner.querySelector('script:not([type="application/json"])')!.textContent).toBe(
      prepareBootstrap().bootstrap
    )
  } finally {
    revoke()
  }
})
