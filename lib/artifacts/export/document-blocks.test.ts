/** @jest-environment jsdom */
import {
  ArtifactNotebookUnreadableError,
  artifactPdfBlocks,
  artifactWordBlocks,
  supportsWordExport,
} from "./document-blocks"
import { ARTIFACT_RUNTIME_ADAPTERS } from "@/components/artifacts/runtime-adapters"
import type { ArtifactType } from "@/types"

const PYTHON = "# a comment, not a heading\ndef f():\n    return 1\n\n    # still code"

describe("supportsWordExport", () => {
  it.each(["document", "code"] as const)("offers Word for %s", (type) => {
    expect(supportsWordExport({ type })).toBe(true)
  })

  it.each(["chart", "mermaid", "math", "svg", "html", "react", "jupyter"] as ArtifactType[])(
    "offers no Word file for %s, whose source is not its text (A07)",
    (type) => expect(supportsWordExport({ type })).toBe(false)
  )
})

describe("artifact document blocks", () => {
  it("keeps code as one verbatim block (A07)", () => {
    const code = { id: "a", type: "code" as const, content: PYTHON }
    expect(artifactPdfBlocks(code)).toEqual([{ kind: "code", text: PYTHON }])
    expect(artifactWordBlocks(code)).toEqual([{ kind: "code", text: PYTHON }])
  })

  it("reads a document as Markdown", () => {
    expect(artifactPdfBlocks({ id: "a", type: "document", content: "# Title\n\nBody" })).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Body" },
    ])
  })

  it("lays a notebook out as its cells", () => {
    const content = JSON.stringify({
      cells: [
        { cell_type: "markdown", source: "# Analysis" },
        { cell_type: "code", source: "print(1)", execution_count: 2, outputs: [] },
      ],
    })
    expect(artifactPdfBlocks({ id: "a", type: "jupyter", content })).toEqual([
      { kind: "heading", level: 1, text: "Analysis" },
      { kind: "paragraph", text: "In [2] (python)" },
      { kind: "code", text: "print(1)" },
    ])
  })

  it.each(["{malformed", "null", '{"cells":null}', '{"cells":[1]}'])(
    "reports an unreadable notebook %s instead of printing its source (C09)",
    (content) => {
      expect(() => artifactPdfBlocks({ id: "nb", type: "jupyter", content })).toThrow(
        ArtifactNotebookUnreadableError
      )
    }
  )

  it("follows the adapter's notebook transport, not just the type name", () => {
    const adapter = ARTIFACT_RUNTIME_ADAPTERS.html
    const previous = adapter.transport
    adapter.transport = "jupyter"
    try {
      expect(() => artifactPdfBlocks({ id: "a", type: "html", content: "# hi" })).toThrow(
        ArtifactNotebookUnreadableError
      )
    } finally {
      adapter.transport = previous
    }
  })
})
