/**
 * An artifact's content as document blocks, for the exports that lay text out:
 * the PDF of a document, code or notebook, and the Word file of a document or
 * code.
 *
 * The content is read for what it is. Only a document is Markdown. Source code
 * used to go through the Markdown parser as well, so a Python `# comment`
 * became a heading and indented lines were trimmed and joined into one
 * paragraph; it is one verbatim code block now. A notebook is its cells, and a
 * notebook that does not parse is reported instead of being printed as its raw
 * JSON, which looked like a successful export of something else.
 *
 * Word is offered only where the blocks are the artifact. A chart, diagram,
 * page or formula has no text form worth a Word file (a chart's Word export
 * used to be its JSON); those export as PNG / PDF, which render them.
 */

import { getArtifactRuntimeAdapter } from "@/components/artifacts/runtime-adapters"
import {
  parseMarkdownBlocks,
  type DocBlock,
  type PdfBlock,
} from "@/lib/files/document-writer/blocks"
import { notebookToDocumentBlocks } from "./notebook-markdown"
import type { Artifact, ArtifactType } from "@/types"

/** The notebook's content is not notebook JSON, so it has no cells to lay out. */
export class ArtifactNotebookUnreadableError extends Error {
  constructor(artifactId: string) {
    super(`artifact ${artifactId} is not readable notebook JSON`)
    this.name = "ArtifactNotebookUnreadableError"
  }
}

/** Artifact types whose Word file is their content laid out as text. */
const WORD_EXPORT_TYPES: ReadonlySet<ArtifactType> = new Set(["document", "code"])

/** Whether "Download as Word" can produce a faithful file for this artifact type. */
export function supportsWordExport(artifact: Pick<Artifact, "type">): boolean {
  return WORD_EXPORT_TYPES.has(artifact.type)
}

/** Artifact types whose PDF is laid-out text rather than a picture. */
const TEXT_PDF_TYPES: ReadonlySet<ArtifactType> = new Set(["document", "code", "jupyter"])

/**
 * Whether this artifact's PDF is a picture of its mounted preview. A
 * text-layout PDF (document, code, notebook) reads the source directly.
 */
export function pdfNeedsMountedPreview(artifact: Pick<Artifact, "type">): boolean {
  return (
    !TEXT_PDF_TYPES.has(artifact.type) &&
    getArtifactRuntimeAdapter(artifact.type).transport !== "jupyter"
  )
}

function sourceBlocks(artifact: Pick<Artifact, "type" | "content">): DocBlock[] {
  return artifact.type === "code"
    ? [{ kind: "code", text: artifact.content }]
    : parseMarkdownBlocks(artifact.content)
}

/** The blocks of a document or code artifact's Word file. */
export function artifactWordBlocks(artifact: Pick<Artifact, "type" | "content">): DocBlock[] {
  return sourceBlocks(artifact)
}

/**
 * The blocks of a text-layout PDF. Throws `ArtifactNotebookUnreadableError`
 * for a notebook whose content is not notebook JSON.
 */
export function artifactPdfBlocks(artifact: Pick<Artifact, "id" | "type" | "content">): PdfBlock[] {
  if (getArtifactRuntimeAdapter(artifact.type).transport === "jupyter") {
    const blocks = notebookToDocumentBlocks(artifact.content)
    if (!blocks) throw new ArtifactNotebookUnreadableError(artifact.id)
    return blocks
  }
  return sourceBlocks(artifact)
}
