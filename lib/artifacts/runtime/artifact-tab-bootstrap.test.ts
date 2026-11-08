/** @jest-environment jsdom */
import { runArtifactTabScripts } from "./artifact-tab-bootstrap"

function harness() {
  const doc = document.implementation.createHTMLDocument()
  const data = doc.createElement("script")
  data.type = "application/json"
  data.textContent = JSON.stringify([
    { code: "first()" },
    { code: "second()", module: true },
    { code: "third()" },
  ])
  const bootstrap = doc.createElement("script")
  doc.body.append(data, bootstrap)
  Object.defineProperty(doc, "currentScript", { value: bootstrap })
  const blobs: BlobPart[][] = []
  class FrameBlob {
    constructor(parts: BlobPart[], options: BlobPropertyBag) {
      blobs.push(parts)
      expect(options).toEqual({ type: "text/javascript" })
    }
  }
  const page = new EventTarget()
  const scope = {
    document: doc,
    URL: {
      createObjectURL: jest.fn(() => `blob:frame-${blobs.length}`),
      revokeObjectURL: jest.fn(),
    },
    Blob: FrameBlob as unknown as typeof Blob,
    addEventListener: page.addEventListener.bind(page),
  }
  return { scope, doc, page, blobs }
}

it("mints and releases frame-owned blobs, preserving classic order and module flags", () => {
  const { scope, doc, page, blobs } = harness()
  runArtifactTabScripts(scope)
  expect(blobs).toEqual([["first()"], ["second()"], ["third()"]])
  const scripts = Array.from(doc.head.querySelectorAll("script[src]")) as HTMLScriptElement[]
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
  expect(scope.URL.revokeObjectURL.mock.calls).toEqual([["blob:frame-1"], ["blob:frame-2"]])
  page.dispatchEvent(new Event("pagehide"))
  expect(scope.URL.revokeObjectURL.mock.calls).toEqual([
    ["blob:frame-1"],
    ["blob:frame-2"],
    ["blob:frame-3"],
  ])
})

it("releases earlier blobs and rethrows if preparing a later script fails", () => {
  const { scope, page } = harness()
  scope.URL.createObjectURL.mockReturnValueOnce("blob:first").mockImplementationOnce(() => {
    throw new Error("blob failed")
  })
  expect(() => runArtifactTabScripts(scope)).toThrow("blob failed")
  expect(scope.URL.revokeObjectURL).toHaveBeenCalledWith("blob:first")
  page.dispatchEvent(new Event("pagehide"))
  expect(scope.URL.revokeObjectURL).toHaveBeenCalledTimes(1)
})

it("rejects malformed embedded program data without minting blobs", () => {
  const { scope, doc } = harness()
  doc.querySelector("script")!.textContent = "invalid JSON"
  expect(() => runArtifactTabScripts(scope)).toThrow(SyntaxError)
  expect(scope.URL.createObjectURL).not.toHaveBeenCalled()
})
