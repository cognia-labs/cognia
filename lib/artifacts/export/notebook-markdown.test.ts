/** @jest-environment jsdom */

import { notebookToDocumentBlocks } from "./notebook-markdown"

function notebook(cells: unknown[], metadata: unknown = {}) {
  return JSON.stringify({ nbformat: 4, metadata, cells })
}

describe("notebookToDocumentBlocks", () => {
  it("preserves Markdown and code cells, kernel language, counts and raw cells", () => {
    expect(
      notebookToDocumentBlocks(
        notebook(
          [
            { cell_type: "markdown", source: ["# Findings\n", "\n- First"] },
            {
              cell_type: "code",
              source: ["const result = `\n", "```\n", "`;"],
              execution_count: 0,
            },
            { cell_type: "code", source: "pending()", execution_count: null },
            { cell_type: "raw", source: "unformatted\ntext" },
          ],
          { kernelspec: { language: "javascript" } }
        )
      )
    ).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "Findings" }] },
      { kind: "listItem", marker: { type: "bullet" }, runs: [{ text: "First" }] },
      { kind: "paragraph", runs: [{ text: "In [0] (javascript)" }] },
      { kind: "code", text: "const result = `\n```\n`;" },
      { kind: "paragraph", runs: [{ text: "In [ ] (javascript)" }] },
      { kind: "code", text: "pending()" },
      { kind: "code", text: "unformatted\ntext" },
    ])
  })

  it("prefers language_info, matching the notebook preview", () => {
    const blocks = notebookToDocumentBlocks(
      notebook([{ cell_type: "code", source: "1" }], {
        language_info: { name: "julia" },
        kernelspec: { language: "python" },
      })
    )
    expect(blocks?.[0]).toEqual({ kind: "paragraph", runs: [{ text: "In [ ] (julia)" }] })
  })

  it("keeps output order, flattens text arrays and strips terminal controls", () => {
    const blocks = notebookToDocumentBlocks(
      notebook([
        {
          cell_type: "code",
          source: "run()",
          execution_count: 2,
          outputs: [
            { output_type: "stream", text: ["hello\n", "world\n"] },
            {
              output_type: "execute_result",
              execution_count: 2,
              data: { "text/plain": ["1\n", "2"] },
            },
            {
              output_type: "error",
              ename: "ValueError",
              evalue: "bad input",
              traceback: [
                "\u001b[31mline 1\u001b[0m",
                "\u001b]8;;https://example.com\u0007details\u001b]8;;\u001b\\",
              ],
            },
            { output_type: "display_data", data: { "text/markdown": ["## Result\n", "\nGood."] } },
          ],
        },
      ])
    )
    expect(blocks?.slice(2)).toEqual([
      { kind: "code", text: "hello\nworld\n" },
      { kind: "paragraph", runs: [{ text: "Out [2]" }] },
      { kind: "code", text: "1\n2" },
      { kind: "code", text: "ValueError: bad input\nline 1\ndetails" },
      { kind: "heading", level: 2, runs: [{ text: "Result" }] },
      { kind: "paragraph", runs: [{ text: "Good." }] },
    ])
  })

  it("embeds PNG and JPEG data and chooses one representation per MIME bundle", () => {
    const blocks = notebookToDocumentBlocks(
      notebook([
        {
          cell_type: "code",
          source: "plot()",
          outputs: [
            {
              output_type: "display_data",
              data: { "image/png": ["cG5n\n", "cG5n"], "text/plain": "duplicate" },
            },
            { output_type: "display_data", data: { "image/jpeg": "anBlZw==" } },
            {
              output_type: "display_data",
              data: { "text/markdown": "# Rich", "text/plain": "duplicate" },
            },
          ],
        },
      ])
    )
    expect(blocks?.slice(2)).toEqual([
      { kind: "image", format: "PNG", dataUrl: "data:image/png;base64,cG5ncG5n" },
      { kind: "image", format: "JPEG", dataUrl: "data:image/jpeg;base64,anBlZw==" },
      { kind: "heading", level: 1, runs: [{ text: "Rich" }] },
    ])
  })

  it("reduces HTML to inert readable text with entities and block boundaries", () => {
    const blocks = notebookToDocumentBlocks(
      notebook([
        {
          cell_type: "code",
          source: "html()",
          outputs: [
            {
              output_type: "display_data",
              data: {
                "text/html": [
                  "<script>window.notebookExecuted = true</script><style>.secret{display:none}</style>",
                  '<p onclick="alert(1)">A &amp; B <b>bold</b></p><p>Next<br>line</p>',
                  '<img src="https://example.com/image" onerror="alert(1)">',
                  '<iframe src="https://example.com">hidden</iframe>',
                ],
              },
            },
          ],
        },
      ])
    )
    expect(blocks?.[2]).toEqual({
      kind: "paragraph",
      runs: [{ text: "A & B bold\n\nNext\n\nline" }],
    })
    expect(document.querySelector("iframe, img, script")).toBeNull()
  })

  it.each(["{broken", "null", "[]", "{}", '{"cells":null}', '{"cells":[null]}'])(
    "returns null for non-notebooks or malformed input %s",
    (content) => {
      expect(notebookToDocumentBlocks(content)).toBeNull()
    }
  )

  it("allows an empty notebook and tolerates absent optional output fields", () => {
    expect(notebookToDocumentBlocks(notebook([]))).toEqual([])
    expect(
      notebookToDocumentBlocks(
        notebook([
          {
            cell_type: "code",
            outputs: [null, { output_type: "error" }, { output_type: "display_data" }],
          },
        ])
      )
    ).toEqual([
      { kind: "paragraph", runs: [{ text: "In [ ] (python)" }] },
      { kind: "code", text: "" },
      { kind: "code", text: "" },
    ])
  })
})
