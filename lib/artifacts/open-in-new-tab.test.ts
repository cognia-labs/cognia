/** @jest-environment jsdom */
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

it("B01 carries granted scripts as data with one external bootstrap in the opaque frame", () => {
  const revoke = grantInteractiveHtml(artifact)
  try {
    const tab = createArtifactTabDocument(artifact, true)
    const { frame, inner, csp } = parse(tab.html)
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    const bootstrap = inner.querySelector('script:not([type="application/json"])')!
    expect(bootstrap.getAttribute("src")).toBe(
      new URL("/artifact-runtime/artifact-tab-bootstrap.js", window.location.href).href
    )
    expect(bootstrap.textContent).toBe("")
    expect(csp).toContain(`script-src ${window.location.origin} blob:`)
    expect(
      inner.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")
    ).toBe(csp)
    expect(inner.querySelector("[onclick]")).toBeNull()
    expect(inner.querySelectorAll("script")).toHaveLength(2)
    expect(inner.querySelectorAll("script[src]")).toHaveLength(1)
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

it.each([
  ["https://app.test/workspace/chat/", "https://app.test"],
  ["tauri://localhost/index.html", "tauri://localhost"],
  ["http://tauri.localhost/index.html", "http://tauri.localhost"],
])("B01 resolves the bootstrap and its CSP host from %s", (baseUrl, origin) => {
  const revoke = grantInteractiveHtml(artifact)
  try {
    const { inner, csp } = parse(createArtifactTabDocument(artifact, true, baseUrl).html)
    expect(inner.querySelector("script[src]")!.getAttribute("src")).toBe(
      `${origin}/artifact-runtime/artifact-tab-bootstrap.js`
    )
    expect(csp.split("; ").find((directive) => directive.startsWith("script-src "))).toBe(
      `script-src ${origin} blob:`
    )
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
    expect(inner.querySelector("iframe")).toBeNull()
    expect(inner.querySelectorAll("script[src]")).toHaveLength(1)
    expect(
      JSON.parse(inner.querySelector('script[type="application/json"]')!.textContent!)
    ).toEqual([])
    tab.dispose()
  } finally {
    revoke()
  }
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
    expect(inner.querySelector("script[src]")!.getAttribute("src")).toBe(
      new URL("/artifact-runtime/artifact-tab-bootstrap.js", window.location.href).href
    )
  } finally {
    revoke()
  }
})
