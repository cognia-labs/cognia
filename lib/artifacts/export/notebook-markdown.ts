import DOMPurify from "dompurify"
import { parseMarkdownBlocks, type PdfBlock } from "@/lib/files/document-writer/blocks"
import type { JupyterNotebook, JupyterOutput } from "@/types"

function notebookText(value: unknown): string {
  if (typeof value === "string") return value
  return Array.isArray(value) && value.every((line) => typeof line === "string")
    ? value.join("")
    : ""
}

function stripAnsi(text: string): string {
  // CSI styling/cursor sequences and OSC links/titles are terminal metadata.
  return text.replace(
    /\x1b\][\s\S]*?(?:\x07|\x1b\\)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g,
    ""
  )
}

function htmlText(html: string): string {
  // A detached, sanitised fragment never mounts output HTML or its resources.
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "div",
      "br",
      "pre",
      "blockquote",
      "li",
      "ul",
      "ol",
      "table",
      "tr",
      "td",
      "th",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
    ],
    ALLOWED_ATTR: [],
    RETURN_DOM_FRAGMENT: true,
  })
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? ""
    const text = Array.from(node.childNodes, read).join("")
    const tag = node.nodeName.toLowerCase()
    if (tag === "td" || tag === "th") return `${text}\t`
    return /^(?:p|div|br|pre|blockquote|li|ul|ol|table|tr|h[1-6])$/.test(tag) ? `\n${text}\n` : text
  }
  return read(fragment)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function outputBlocks(output: JupyterOutput): PdfBlock[] {
  if (output.output_type === "stream") {
    return [{ kind: "code", text: stripAnsi(notebookText(output.text)) }]
  }
  if (output.output_type === "error") {
    const summary = [notebookText(output.ename), notebookText(output.evalue)]
      .filter(Boolean)
      .join(": ")
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.map(notebookText).join("\n")
      : notebookText(output.traceback)
    return [{ kind: "code", text: stripAnsi([summary, traceback].filter(Boolean).join("\n")) }]
  }

  // A MIME bundle describes alternative representations of one result. Prefer
  // the rich representation, rather than printing its text/plain duplicate.
  const data = output.data
  for (const [mime, format] of [
    ["image/png", "PNG"],
    ["image/jpeg", "JPEG"],
  ] as const) {
    const base64 = notebookText(data?.[mime]).replace(/\s/g, "")
    if (base64) return [{ kind: "image", dataUrl: `data:${mime};base64,${base64}`, format }]
  }
  const markdown = notebookText(data?.["text/markdown"])
  if (markdown) return parseMarkdownBlocks(markdown)
  const html = notebookText(data?.["text/html"])
  if (html) return [{ kind: "paragraph", text: htmlText(html) }]
  const text = notebookText(data?.["text/plain"])
  return text ? [{ kind: "code", text: stripAnsi(text) }] : []
}

/** Convert notebook Markdown, fenced code and output into ordered PDF blocks. */
export function notebookToDocumentBlocks(content: string): PdfBlock[] | null {
  let notebook: JupyterNotebook | null
  try {
    notebook = JSON.parse(content) as JupyterNotebook | null
  } catch {
    return null
  }
  if (!notebook || !Array.isArray(notebook.cells)) return null
  const languageName =
    notebook.metadata?.language_info?.name || notebook.metadata?.kernelspec?.language
  const language = typeof languageName === "string" ? languageName : "python"
  const blocks: PdfBlock[] = []

  for (const cell of notebook.cells) {
    if (!cell || typeof cell !== "object") return null
    const source = notebookText(cell.source)
    if (cell.cell_type === "markdown") {
      blocks.push(...parseMarkdownBlocks(source))
    } else if (cell.cell_type === "code") {
      blocks.push({ kind: "paragraph", text: `In [${cell.execution_count ?? " "}] (${language})` })
      // Keep code as a fenced block directly: literal backticks inside a cell
      // must not close a fence in the Markdown parser.
      blocks.push({ kind: "code", text: source })
      for (const output of Array.isArray(cell.outputs) ? cell.outputs : []) {
        if (!output || typeof output !== "object") continue
        if (output.output_type === "execute_result" && output.execution_count != null) {
          blocks.push({ kind: "paragraph", text: `Out [${output.execution_count}]` })
        }
        blocks.push(...outputBlocks(output))
      }
    } else {
      blocks.push({ kind: "code", text: source })
    }
  }
  return blocks
}
