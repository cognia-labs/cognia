import { MAX_LIST_LEVEL, parseMarkdownBlocks } from "./markdown"
import {
  createDocument,
  DOCX_MIME,
  materializeBlock,
  type DocumentBlock,
  type DocumentComment,
  type DocumentModel,
  type HeadingLevel,
} from "./model"

interface ImportedCommentInfo {
  author: string
  text: string
  paraId?: string
}

/**
 * Localized strings the importer writes into the model. They become document
 * content the user reads (comment bodies, authors, the fallback title), so the
 * caller resolves them through `ctx.i18n.t` instead of baking in English.
 */
export interface DocxImportLabels {
  /** Body of a Word comment that carried no text. */
  emptyComment: string
  /** Author of a Word comment that carried no author. */
  unknownAuthor: string
  /** Title when neither the package, the body, nor the filename supplies one. */
  untitled: string
}

export const DEFAULT_DOCX_IMPORT_LABELS: DocxImportLabels = {
  emptyComment: "(empty comment)",
  unknownAuthor: "Unknown",
  untitled: "Document",
}

/**
 * Stable ids for the native features the model cannot round-trip. The ids are
 * what `importedFeatures` stores; the preview localizes them through
 * `feature.<id>` keys, and the export guard lists them to the model.
 */
export const DOCX_FEATURE_IDS = [
  "tracked-changes",
  "document-protection",
  "images",
  "hyperlinks",
  "drawings",
  "embedded-objects",
  "footnotes",
  "endnotes",
  "headers-footers",
  "fields",
  "content-controls",
  "section-page-setup",
  "embedded-external-content",
  "merged-table-cells",
  "page-breaks",
  "inline-formatting",
  "paragraph-formatting",
  "table-formatting",
  "nested-tables",
  "styles",
  "custom-numbering",
  "equations-symbols",
  "comment-metadata",
  "comment-anchors",
] as const
export type DocxFeatureId = (typeof DOCX_FEATURE_IDS)[number]

type DocxFileChild = import("docx").FileChild
type DocxParagraphChild = import("docx").ParagraphChild

/** Minimal structural view of a JSZip instance (keeps helpers sync-friendly). */
interface ZipLike {
  file(name: string): { async(kind: "string"): Promise<string> } | null
  files: Record<string, unknown>
}

export async function importDocx(
  bytes: Uint8Array,
  filename = "document.docx",
  labels: DocxImportLabels = DEFAULT_DOCX_IMPORT_LABELS,
  /** A caller-chosen title; wins over the file's own. */
  titleOverride?: string
): Promise<DocumentModel> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const documentFile = zip.file("word/document.xml")
  if (!documentFile) throw new Error("Invalid DOCX package: word/document.xml is missing.")
  const xml = await documentFile.async("string")

  const features = await detectFeatures(zip, xml)
  const numbering = await readNumbering(zip)
  const comments = await readComments(zip)
  const commentDone = await readResolvedCommentParaIds(zip)
  const coreTitle = await readCoreTitle(zip)

  const commentIdsByBlock = new Map<number, number[]>()
  const scanned = scanBody(xml, numbering, commentIdsByBlock)

  // `exportDocx` writes the model title as the body's first paragraph (Word's
  // "Title" style) AND into core.xml. Reading that paragraph back as a heading
  // block duplicated the title on every round trip, so a leading Title
  // paragraph is the document title, not content, and a comment on it is a
  // comment on the whole document.
  const leadingTitle = scanned.titleParagraph
  const leadingText = leadingTitle?.text.trim() ?? ""
  const override = titleOverride?.trim() ?? ""
  const title =
    override || leadingText || coreTitle || filename.replace(/\.docx$/i, "") || labels.untitled
  const model = createDocument(title)
  model.sourceFilename = filename
  model.importedFeatures = features
  model.blocks = scanned.blocks
  // A caller-chosen title replaces the Title paragraph, which then stays as
  // content (with its comments). `b0`: parsed block ids start at `b1`.
  const titleBlock: DocumentBlock | null =
    leadingText && override && override !== leadingText
      ? { id: "b0", type: "heading", level: 1, text: leadingText }
      : null
  if (titleBlock) model.blocks = [titleBlock, ...model.blocks]
  let commentSequence = 1
  const addComment = (commentId: number, blockId: string | undefined) => {
    const info = comments.get(commentId)
    if (!info) return
    model.comments.push({
      id: `m${commentSequence++}`,
      ...(blockId === undefined ? {} : { blockId }),
      text: info.text || labels.emptyComment,
      author: info.author || labels.unknownAuthor,
      resolved: info.paraId ? commentDone.has(info.paraId) : false,
    })
  }
  for (const commentId of leadingTitle?.commentIds ?? []) addComment(commentId, titleBlock?.id)
  for (const [blockIndex, commentIds] of commentIdsByBlock) {
    const block = scanned.blocks[blockIndex]
    if (!block) continue
    for (const commentId of commentIds) addComment(commentId, block.id)
  }
  // A comments.xml entry with no range in the body still carries what its
  // author wrote. It is kept on the whole document, never pinned to whichever
  // block comes first, and its lost range is reported ("comment-anchors").
  const anchored = new Set([
    ...(leadingTitle?.commentIds ?? []),
    ...[...commentIdsByBlock.values()].flat(),
  ])
  for (const commentId of comments.keys()) {
    if (!anchored.has(commentId)) addComment(commentId, undefined)
  }
  return model
}

export async function exportDocx(model: DocumentModel): Promise<Uint8Array> {
  const docx = await import("docx")
  const commentNumber = new Map<string, number>()
  model.comments.forEach((comment, index) => commentNumber.set(comment.id, index + 1))
  // A comment on the document as a whole sits on the title, the one
  // paragraph that stands for all of it.
  const documentComments = model.comments.filter((comment) => comment.blockId === undefined)
  const children: DocxFileChild[] = [
    new docx.Paragraph({
      heading: docx.HeadingLevel.TITLE,
      children: withCommentRange(
        [new docx.TextRun(model.title)],
        documentComments,
        commentNumber,
        docx
      ),
    }),
  ]
  for (const block of model.blocks) children.push(renderBlock(block, model, commentNumber, docx))
  const document = new docx.Document({
    creator: "Cognia",
    title: model.title,
    comments: model.comments.length
      ? {
          children: model.comments.map((comment) => ({
            id: commentNumber.get(comment.id)!,
            author: comment.author,
            date: new Date(),
            resolved: comment.resolved,
            children: [new docx.Paragraph(comment.text)],
          })),
        }
      : undefined,
    styles: {
      paragraphStyles: [
        {
          id: QUOTE_STYLE_ID,
          name: "Quote",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { italics: true, color: "595959" },
          paragraph: {
            indent: { left: 720, right: 720 },
            border: {
              left: { style: docx.BorderStyle.SINGLE, size: 12, color: "BFBFBF", space: 8 },
            },
          },
        },
        {
          id: CODE_STYLE_ID,
          name: "Source Code",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: "Consolas", size: 20 },
          paragraph: {
            spacing: { before: 120, after: 120 },
            shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "F2F2F2" },
          },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "default-numbering",
          // Word cycles decimal → letter → roman as ordered lists nest.
          levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
            level,
            format: [
              docx.LevelFormat.DECIMAL,
              docx.LevelFormat.LOWER_LETTER,
              docx.LevelFormat.LOWER_ROMAN,
            ][level % 3],
            text: `%${level + 1}.`,
            alignment: docx.AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  })
  const blob = await docx.Packer.toBlob(document)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return model.comments.length ? writeCommentStates(bytes, model, commentNumber) : bytes
}

const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
const COMMENTS_EXTENDED_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"
const COMMENTS_EXTENDED_REL =
  "http://schemas.microsoft.com/office/2011/relationships/commentsExtended"

/**
 * A comment's paragraph id: unique in the package and below 0x80000000, as
 * [MS-DOCX] requires. Body paragraphs carry none, so comment numbers suffice.
 */
function commentParaId(commentNumber: number): string {
  return (0x10000000 + commentNumber).toString(16).toUpperCase()
}

/**
 * Write each comment's resolved state, which Word keeps in
 * `word/commentsExtended.xml` (`w15:done`) keyed by the paragraph id of the
 * comment's last paragraph. The `docx` writer emits that part only for reply
 * threads, so an ordinary resolved comment reopened as open; this adds the
 * paragraph ids, the part, its content type and its relationship.
 */
async function writeCommentStates(
  bytes: Uint8Array,
  model: DocumentModel,
  commentNumber: Map<string, number>
): Promise<Uint8Array> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  if (zip.file("word/commentsExtended.xml")) return bytes
  let commentsXml = await zip.file("word/comments.xml")!.async("string")
  if (!/\sxmlns:w14=/.test(commentsXml))
    commentsXml = commentsXml.replace(/<w:comments\b/, `<w:comments xmlns:w14="${W14_NS}"`)
  commentsXml = commentsXml.replace(
    /(<w:comment\b[^>]*\bw:id="(\d+)"[^>]*>)([\s\S]*?)(<\/w:comment>)/g,
    (_, open: string, id: string, body: string, close: string) => {
      const paraId = commentParaId(Number(id))
      const last = Math.max(body.lastIndexOf("<w:p>"), body.lastIndexOf("<w:p "))
      if (last < 0 || /^<w:p\b[^>]*\bw14:paraId=/.test(body.slice(last))) return open + body + close
      const tagged = `<w:p w14:paraId="${paraId}" w14:textId="${paraId}"${body.slice(last + 4)}`
      return open + body.slice(0, last) + tagged + close
    }
  )
  zip.file("word/comments.xml", commentsXml)
  const entries = model.comments
    .map(
      (comment) =>
        `<w15:commentEx w15:paraId="${commentParaId(commentNumber.get(comment.id)!)}" w15:done="${
          comment.resolved ? "1" : "0"
        }"/>`
    )
    .join("")
  zip.file(
    "word/commentsExtended.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w15:commentsEx xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
      'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" mc:Ignorable="w15">' +
      `${entries}</w15:commentsEx>`
  )
  const types = await zip.file("[Content_Types].xml")!.async("string")
  zip.file(
    "[Content_Types].xml",
    types.replace(
      "</Types>",
      `<Override PartName="/word/commentsExtended.xml" ContentType="${COMMENTS_EXTENDED_TYPE}"/></Types>`
    )
  )
  const relsPath = "word/_rels/document.xml.rels"
  const rels = await zip.file(relsPath)!.async("string")
  const taken = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((match) => match[1]))
  let n = 1
  while (taken.has(`rIdCommentsEx${n}`)) n += 1
  zip.file(
    relsPath,
    rels.replace(
      "</Relationships>",
      `<Relationship Id="rIdCommentsEx${n}" Type="${COMMENTS_EXTENDED_REL}" Target="commentsExtended.xml"/></Relationships>`
    )
  )
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}

/**
 * Reopen a generated DOCX and check it is the document it claims to be.
 *
 * Reopening and extracting text is not enough: a table comment once came back
 * with zero anchors, re-imported onto the first paragraph, and this still said
 * "valid". So the comments are checked too. Every comment in `comments.xml`
 * needs exactly one range start, one range end and one reference mark in the
 * body, and no mark may name a comment that does not exist. Given the model
 * the file was written from (`expected`), each comment must also come back on
 * the same block (or on the whole document) with the same text, author and
 * state. Each failure is one entry in `issues`.
 */
export async function validateDocxRoundTrip(
  bytes: Uint8Array,
  expected?: DocumentModel
): Promise<{ valid: boolean; text: string; issues: string[] }> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  if (!zip.file("[Content_Types].xml") || !zip.file("word/document.xml"))
    return { valid: false, text: "", issues: ["The package has no document part."] }
  const documentXml = await zip.file("word/document.xml")!.async("string")
  const text = extractParagraphText(documentXml).join("\n\n")
  const commentsXml = (await zip.file("word/comments.xml")?.async("string")) ?? ""
  const issues = commentRelationIssues(documentXml, commentsXml)
  if (expected) issues.push(...(await commentPlacementIssues(bytes, expected)))
  return { valid: issues.length === 0, text, issues }
}

/** Range and reference marks that do not pair up with `comments.xml`. */
function commentRelationIssues(documentXml: string, commentsXml: string): string[] {
  const issues: string[] = []
  const ids = [...commentsXml.matchAll(/<w:comment\b([^>]*)>/g)].map(
    (match) => attr(match[1], "w:id") ?? ""
  )
  const known = new Set(ids)
  const marks = (tag: string) =>
    [...documentXml.matchAll(new RegExp(`<w:${tag}\\b([^>]*)/>`, "g"))].map(
      (match) => attr(match[1], "w:id") ?? ""
    )
  const kinds = {
    "range start": marks("commentRangeStart"),
    "range end": marks("commentRangeEnd"),
    reference: marks("commentReference"),
  }
  for (const id of ids) {
    for (const [kind, found] of Object.entries(kinds)) {
      const count = found.filter((candidate) => candidate === id).length
      if (count !== 1)
        issues.push(`Comment ${id} has ${count} ${kind} marks; it needs exactly one.`)
    }
  }
  for (const [kind, found] of Object.entries(kinds)) {
    for (const id of new Set(found)) {
      if (!known.has(id))
        issues.push(`A comment ${kind} mark names comment ${id}, which does not exist.`)
    }
  }
  return issues
}

/** What a comment is on, comparable across a round trip that renumbers block ids. */
function blockSignature(block: DocumentBlock | undefined): string {
  if (!block) return "document"
  if (block.type === "table") return `table:${JSON.stringify(block.rows)}`
  return `${block.type}:${block.text.trim()}`
}

/**
 * Comments that came back on another block, or changed, after reopening the
 * file. Reopening lists comments in document order, not in the model's, so
 * they are matched as a multiset of (target block, text, author, state).
 */
async function commentPlacementIssues(
  bytes: Uint8Array,
  expected: DocumentModel
): Promise<string[]> {
  const reopened = await importDocx(bytes)
  const describe = (model: DocumentModel, comment: DocumentComment) =>
    JSON.stringify([
      blockSignature(
        comment.blockId === undefined
          ? undefined
          : model.blocks.find((block) => block.id === comment.blockId)
      ),
      comment.text,
      comment.author,
      comment.resolved,
    ])
  const remaining = new Map<string, number>()
  for (const comment of reopened.comments) {
    const key = describe(reopened, comment)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const issues: string[] = []
  for (const comment of expected.comments) {
    const key = describe(expected, comment)
    const left = remaining.get(key) ?? 0
    if (left > 0) remaining.set(key, left - 1)
    else issues.push(`Comment ${comment.id} does not reopen on its block with its text and state.`)
  }
  const extra = [...remaining.values()].reduce((sum, count) => sum + count, 0)
  if (extra > 0)
    issues.push(`The file reopens with ${extra} comment(s) the document does not have.`)
  return issues
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Paragraph styles the exporter defines and the importer maps back to blocks. */
const QUOTE_STYLE_ID = "Quote"
const CODE_STYLE_ID = "SourceCode"
const QUOTE_STYLES = /^(quote|intensequote)$/i
const CODE_STYLES = /^(sourcecode|code|codeblock|htmlpreformatted|plaintext|macrotext)$/i

function renderBlock(
  block: DocumentBlock,
  model: DocumentModel,
  commentNumber: Map<string, number>,
  docx: typeof import("docx")
): DocxFileChild {
  const { HeadingLevel, Paragraph } = docx
  if (block.type === "table") return renderTable(block, model, commentNumber, docx)
  const runs = paragraphChildren(block, model, commentNumber, docx)
  if (block.type === "heading")
    return new Paragraph({
      children: runs,
      heading: [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ][block.level - 1],
    })
  if (block.type === "list-item") {
    const level = block.level ?? 0
    return new Paragraph({
      children: runs,
      bullet: block.ordered ? undefined : { level },
      numbering: block.ordered ? { reference: "default-numbering", level } : undefined,
    })
  }
  if (block.type === "quote") return new Paragraph({ children: runs, style: QUOTE_STYLE_ID })
  if (block.type === "code") return new Paragraph({ children: runs, style: CODE_STYLE_ID })
  return new Paragraph({ children: runs })
}

/**
 * Build a paragraph's run list: real Word comment ranges around the text, and
 * pending tracked changes emitted as w:ins/w:del pairs (del = earliest pending
 * `before`, ins = the block's current text).
 */
function paragraphChildren(
  block: Exclude<DocumentBlock, { type: "table" }>,
  model: DocumentModel,
  commentNumber: Map<string, number>,
  docx: typeof import("docx")
): DocxParagraphChild[] {
  const pending = model.changes.find((change) => change.blockId === block.id && !change.accepted)
  const date = new Date().toISOString()
  const runs: DocxParagraphChild[] = pending
    ? [
        ...revisionRuns(pending.before, docx.DeletedTextRun, pending.id, 0, date, docx),
        ...revisionRuns(block.text, docx.InsertedTextRun, pending.id, 5000, date, docx),
      ]
    : textRuns(block.text, docx)
  const comments = model.comments.filter((comment) => comment.blockId === block.id)
  return withCommentRange(runs, comments, commentNumber, docx)
}

/** The opening and closing halves of a Word comment range over `comments`. */
function commentRangeParts(
  comments: readonly DocumentComment[],
  commentNumber: Map<string, number>,
  docx: typeof import("docx")
): { start: DocxParagraphChild[]; end: DocxParagraphChild[] } {
  const { CommentRangeEnd, CommentRangeStart, CommentReference, TextRun } = docx
  if (!comments.length) return { start: [], end: [] }
  const number = (comment: DocumentComment) => commentNumber.get(comment.id)!
  return {
    start: comments.map((comment) => new CommentRangeStart(number(comment))),
    end: [
      ...comments.map((comment) => new CommentRangeEnd(number(comment))),
      new TextRun({ children: comments.map((comment) => new CommentReference(number(comment))) }),
    ],
  }
}

/** `runs` inside one comment range per comment, with the comments' reference marks after them. */
function withCommentRange(
  runs: DocxParagraphChild[],
  comments: readonly DocumentComment[],
  commentNumber: Map<string, number>,
  docx: typeof import("docx")
): DocxParagraphChild[] {
  const { start, end } = commentRangeParts(comments, commentNumber, docx)
  return [...start, ...runs, ...end]
}

/**
 * A table, with each of its comments ranging over the whole table: the range
 * opens before the first cell's text and closes after the last cell's, which
 * is how Word itself anchors a comment on a selected table. A comment on a
 * table with no cells gets one empty cell to sit in; Word has no range for
 * a table without one.
 */
function renderTable(
  block: Extract<DocumentBlock, { type: "table" }>,
  model: DocumentModel,
  commentNumber: Map<string, number>,
  docx: typeof import("docx")
): DocxFileChild {
  const { Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = docx
  const comments = model.comments.filter((comment) => comment.blockId === block.id)
  const rows = comments.length && !block.rows.some((row) => row.length) ? [[""]] : block.rows
  const { start, end } = commentRangeParts(comments, commentNumber, docx)
  const firstRow = rows.findIndex((row) => row.length > 0)
  let lastRow = -1
  rows.forEach((row, index) => {
    if (row.length > 0) lastRow = index
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (row, rowIndex) =>
        new TableRow({
          children: row.map((cell, cellIndex) => {
            const lines = cell.split("\n")
            const opens = rowIndex === firstRow && cellIndex === 0
            const closes = rowIndex === lastRow && cellIndex === row.length - 1
            return new TableCell({
              children: lines.map((line, lineIndex) => {
                const first = opens && lineIndex === 0
                const last = closes && lineIndex === lines.length - 1
                if (!comments.length || (!first && !last)) return new Paragraph(line)
                return new Paragraph({
                  children: [...(first ? start : []), new TextRun(line), ...(last ? end : [])],
                })
              }),
            })
          }),
        })
    ),
  })
}

/**
 * Runs for multi-line, tabbed text. The `docx` writer emits a run's `break`
 * BEFORE its text, so each line after the first opens with the break — a
 * trailing break on the previous run would push every line down by one and
 * lose blank lines.
 */
function textRuns(text: string, docx: typeof import("docx")): DocxParagraphChild[] {
  const { Tab, TextRun } = docx
  const runs: DocxParagraphChild[] = []
  splitText(text).forEach((line, index) => {
    line.split("\t").forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) runs.push(new TextRun({ children: [new Tab()] }))
      const lineBreak = index > 0 && segmentIndex === 0 ? 1 : undefined
      if (segment || lineBreak || (index === 0 && segmentIndex === 0))
        runs.push(new TextRun({ text: segment, break: lineBreak }))
    })
  })
  return runs
}

function splitText(text: string): string[] {
  return text.split("\n")
}

type RevisionRunCtor =
  (typeof import("docx"))["InsertedTextRun"] | (typeof import("docx"))["DeletedTextRun"]

/** `textRuns` for a tracked insertion or deletion; every run carries the revision. */
function revisionRuns(
  text: string,
  Ctor: RevisionRunCtor,
  changeId: string,
  salt: number,
  date: string,
  docx: typeof import("docx")
): DocxParagraphChild[] {
  const { Tab } = docx
  const base = (Number.parseInt(changeId.replace(/\D+/g, ""), 10) || 0) * 10000 + salt
  const runs: DocxParagraphChild[] = []
  let runIndex = 0
  const revision = () => ({ id: base + runIndex++, author: "Cognia", date })
  splitText(text).forEach((line, index) => {
    line.split("\t").forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) runs.push(new Ctor({ children: [new Tab()], ...revision() }))
      const lineBreak = index > 0 && segmentIndex === 0 ? 1 : undefined
      if (segment || lineBreak)
        runs.push(new Ctor({ text: segment, break: lineBreak, ...revision() }))
    })
  })
  return runs
}

// ---------------------------------------------------------------------------
// Import — feature detection
// ---------------------------------------------------------------------------

async function detectFeatures(zip: ZipLike, documentXml: string): Promise<DocxFeatureId[]> {
  const features: DocxFeatureId[] = []
  const names = Object.keys(zip.files)
  const has = (prefix: string) => names.some((name) => name.startsWith(prefix))
  if (/<w:(ins|del|moveFrom|moveTo)\b/.test(documentXml)) features.push("tracked-changes")
  const settings = zip.file("word/settings.xml")
  if (settings && /<w:documentProtection\b/.test(await settings.async("string")))
    features.push("document-protection")
  if (has("word/media/")) features.push("images")
  if (/<w:hyperlink\b/.test(documentXml)) features.push("hyperlinks")
  if (/<w:(drawing|pict)\b/.test(documentXml)) features.push("drawings")
  if (has("word/embeddings/") || has("word/diagrams/")) features.push("embedded-objects")
  // Word (and the `docx` writer this plugin exports with) always ships
  // footnotes.xml / endnotes.xml holding only the separator notes, so the part
  // existing says nothing. Only a real note reference in the body, or a note
  // that is not a separator, is content the model would drop.
  if (await hasRealNotes(zip, documentXml, "footnote")) features.push("footnotes")
  if (await hasRealNotes(zip, documentXml, "endnote")) features.push("endnotes")
  if (names.some((name) => /^word\/(header|footer)\d*\.xml$/.test(name)))
    features.push("headers-footers")
  if (/<w:(instrText|fldSimple)\b|<w:fldChar\b/.test(documentXml)) features.push("fields")
  if (/<w:sdt\b/.test(documentXml)) features.push("content-controls")
  // A single section can still carry landscape, custom margins, columns, or
  // page numbering. Compare with what our writer actually reconstructs.
  const defaults = await readExportDefaults()
  const sections = elements(documentXml, "sectPr")
  if (sections.length > 1 || sections.some((section) => !matchesDefault(section, defaults.section)))
    features.push("section-page-setup")
  if (/<w:altChunk\b/.test(documentXml)) features.push("embedded-external-content")
  if (/<w:(gridSpan|vMerge)\b/.test(documentXml)) features.push("merged-table-cells")
  if (/<w:br[^>]*w:type="(?:page|column)"|<w:pageBreakBefore\b/.test(documentXml))
    features.push("page-breaks")
  if (
    elements(documentXml, "rPr").some((xml) =>
      /<w:/.test(
        xml
          .replace(/<\/?w:rPr\b[^>]*>/g, "")
          .replace(/<w:rStyle\b[^>]*w:val="CommentReference"[^>]*\/>/g, "")
      )
    )
  )
    features.push("inline-formatting")
  if (
    elements(documentXml, "pPr").some((xml) =>
      /<w:/.test(
        xml
          .replace(/<\/?w:pPr\b[^>]*>/g, "")
          .replace(/<w:(pStyle|outlineLvl)\b[^>]*\/>/g, "")
          .replace(/<w:numPr\b[^>]*>[\s\S]*?<\/w:numPr>/g, "")
      )
    )
  )
    features.push("paragraph-formatting")
  if (
    elements(documentXml, "tblPr").some((xml) => !matchesDefault(xml, defaults.table)) ||
    /<w:(tcPr|trPr)\b[^>]*>\s*<w:/.test(documentXml) ||
    (await hasCustomColumnWidths(documentXml))
  )
    features.push("table-formatting")
  let tableDepth = 0
  for (const match of documentXml.matchAll(/<\/?w:tbl\b[^>]*>/g)) {
    if (match[0].startsWith("</")) tableDepth -= 1
    else if (!match[0].endsWith("/>")) tableDepth += 1
    if (tableDepth > 1) {
      features.push("nested-tables")
      break
    }
  }
  if (await hasChangedStyles(zip, documentXml, defaults.styles)) features.push("styles")
  if (await hasChangedNumbering(zip, documentXml, defaults.numbering))
    features.push("custom-numbering")
  if (/<m:oMath\b|<m:oMathPara\b|<w:sym\b|<w:(?:noBreakHyphen|softHyphen)\b/.test(documentXml))
    features.push("equations-symbols")
  const comments = await zip.file("word/comments.xml")?.async("string")
  const threads = await zip.file("word/commentsExtended.xml")?.async("string")
  if (
    comments &&
    (/\bw:(date|initials)=/.test(comments) ||
      /<w:(rPr|pPr|tbl|hyperlink|drawing)\b/.test(comments) ||
      /\bw15:paraIdParent=/.test(threads ?? ""))
  )
    features.push("comment-metadata")
  if (comments && hasChangedCommentAnchors(documentXml, comments)) features.push("comment-anchors")
  return features
}

interface ExportDefaults {
  section: string
  table: string
  styles: string
  numbering: string
}
let exportDefaults: Promise<ExportDefaults> | undefined

/** Derive defaults from the existing writer, so dependency updates cannot stale a parallel format specification. */
function readExportDefaults(): Promise<ExportDefaults> {
  return (exportDefaults ??= (async () => {
    const model = createDocument("Defaults")
    model.blocks.push({ id: "b1", type: "table", rows: [[""]] })
    model.blocks.push({ id: "b2", type: "list-item", ordered: true, text: "" })
    model.comments.push({ id: "m1", blockId: "b2", author: "Cognia", text: "", resolved: false })
    const JSZip = (await import("jszip")).default
    const zip = await JSZip.loadAsync(await exportDocx(model))
    const xml = await zip.file("word/document.xml")!.async("string")
    return {
      section: elements(xml, "sectPr")[0],
      table: elements(xml, "tblPr")[0],
      styles: await zip.file("word/styles.xml")!.async("string"),
      numbering: await zip.file("word/numbering.xml")!.async("string"),
    }
  })().catch((error: unknown) => {
    exportDefaults = undefined
    throw error
  }))
}

const writerGrids = new Map<number, Promise<string[]>>()

/**
 * The grid column widths our writer gives a plain table of `columns` columns.
 * The `docx` writer derives them from the table and section widths (9.9 splits
 * the section's text width; 9.7 wrote 100 per column), so ask it rather than
 * hard-coding a value a dependency update can stale.
 */
function writerGridWidths(columns: number): Promise<string[]> {
  let grid = writerGrids.get(columns)
  if (!grid) {
    grid = (async () => {
      const model = createDocument("Defaults")
      model.blocks.push({
        id: "b1",
        type: "table",
        rows: [Array.from({ length: columns }, () => "")],
      })
      const JSZip = (await import("jszip")).default
      const zip = await JSZip.loadAsync(await exportDocx(model))
      const xml = await zip.file("word/document.xml")!.async("string")
      return gridWidths(elements(xml, "tblGrid")[0] ?? "")
    })()
    grid.catch(() => writerGrids.delete(columns))
    writerGrids.set(columns, grid)
  }
  return grid
}

function gridWidths(grid: string): string[] {
  return [...grid.matchAll(/<w:gridCol\b([^>]*)\/>/g)].map((match) => attr(match[1], "w:w") ?? "")
}

/** A table grid other than the one our writer would emit carries column widths the model drops. */
async function hasCustomColumnWidths(documentXml: string): Promise<boolean> {
  for (const grid of elements(documentXml, "tblGrid")) {
    const widths = gridWidths(grid)
    if (widths.length === 0) continue
    const expected = await writerGridWidths(widths.length)
    if (widths.some((width, index) => width !== expected[index])) return true
  }
  return false
}

function elements(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<w:${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</w:${tag}>)`, "g"))].map(
    (match) => match[0]
  )
}

function normalizeXml(xml: string): string {
  return xml
    .replace(/>\s+</g, "><")
    .replace(/<([\w:]+)([^<>]*?)>/g, (_, tag: string, attributes: string) => {
      const attrs = [...attributes.matchAll(/([\w:]+)="([^"]*)"/g)]
        .filter((match) => !match[1].startsWith("w:rsid"))
        .map((match) => `${match[1]}="${match[2]}"`)
        .sort()
        .join(" ")
      return `<${tag}${attrs ? ` ${attrs}` : ""}${attributes.endsWith("/") ? "/" : ""}>`
    })
    .trim()
}

function matchesDefault(xml: string, expected: string): boolean {
  // Empty property containers specify no extra formatting.
  return /^<w:\w+\s*\/>$/.test(xml) || normalizeXml(xml) === normalizeXml(expected)
}

async function hasChangedStyles(
  zip: ZipLike,
  documentXml: string,
  defaults: string
): Promise<boolean> {
  const source = (await zip.file("word/styles.xml")?.async("string")) ?? ""
  const styles = new Map(elements(source, "style").map((xml) => [attr(xml, "w:styleId"), xml]))
  const expected = new Map(elements(defaults, "style").map((xml) => [attr(xml, "w:styleId"), xml]))
  const docDefaults = elements(source, "docDefaults")[0]
  if (docDefaults && !matchesDefault(docDefaults, elements(defaults, "docDefaults")[0] ?? ""))
    return true
  const used = new Set<string>()
  for (const id of ["Normal", "DefaultParagraphFont"]) if (styles.has(id)) used.add(id)
  for (const match of documentXml.matchAll(/<w:(?:pStyle|rStyle|tblStyle)\b([^>]*)\/>/g)) {
    const id = attr(match[1], "w:val")
    if (id) used.add(id)
  }
  for (const [id, xml] of styles) if (id && attr(xml, "w:default") === "1") used.add(id)
  for (const id of used) {
    const xml = styles.get(id)
    if (!expected.has(id)) {
      if (!xml && ["Normal", "DefaultParagraphFont"].includes(id)) continue
      return true
    }
    if (xml && normalizeXml(xml) !== normalizeXml(expected.get(id)!)) return true
  }
  return false
}

async function hasChangedNumbering(
  zip: ZipLike,
  documentXml: string,
  defaults: string
): Promise<boolean> {
  const used = [...documentXml.matchAll(/<w:numId\b([^>]*)\/>/g)].map((match) =>
    attr(match[1], "w:val")
  )
  if (!used.length) return false
  const source = (await zip.file("word/numbering.xml")?.async("string")) ?? ""
  const stripId = (xml: string) => normalizeXml(xml.replace(/\bw:abstractNumId="[^"]*"/g, ""))
  const expected = new Set(elements(defaults, "abstractNum").map(stripId))
  // The restarts our writer emits for a fresh list (`docx` restarts every
  // level, 0–8, at 1), read from its own output rather than spelled out here.
  const writerRestarts = new Set(elements(defaults, "lvlOverride").map(normalizeXml))
  const sequences = new Set<string>()
  for (const id of new Set(used)) {
    const num = elements(source, "num").find((xml) => attr(xml, "w:numId") === id)
    const abstractId = num && /<w:abstractNumId\b[^>]*w:val="([^"]*)"/.exec(num)?.[1]
    const abstract = elements(source, "abstractNum").find(
      (xml) => attr(xml, "w:abstractNumId") === abstractId
    )
    if (!num || !abstract || !expected.has(stripId(abstract))) return true
    if (sequences.has(stripId(abstract))) return true
    sequences.add(stripId(abstract))
    // Any other override (a list continuing at 5, a changed level format) is
    // lost even when the abstract format matches.
    if (elements(num, "lvlOverride").some((xml) => !writerRestarts.has(normalizeXml(xml))))
      return true
  }
  return new Set(used).size > 2 || /<w:ilvl\b[^>]*w:val="(?:9|\d{2,})"/.test(documentXml)
}

/**
 * Whether a comment's range is one the model cannot keep. The model anchors a
 * comment on a whole block (a paragraph, a table) or on the whole document
 * (the Title paragraph), so a range must cover all of its paragraph's text, or
 * all of a table from before its first cell's text to after its last cell's.
 * A range over part of a paragraph, a single cell, or nothing at all (a
 * comment with no range in the body) is reported as lost.
 */
function hasChangedCommentAnchors(documentXml: string, commentsXml: string): boolean {
  const paragraphs = elements(documentXml, "p")
  const tables = elements(documentXml, "tbl")
  const covers = (paragraph: string, start: RegExpExecArray | null, end: RegExpExecArray | null) =>
    Boolean(
      start &&
      end &&
      !paragraphText(paragraph.slice(0, start.index)).trim() &&
      !paragraphText(paragraph.slice(end.index + end[0].length)).trim()
    )
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>/g)) {
    const id = attr(match[1], "w:id")
    if (!id || !/^\d+$/.test(id)) return true
    const startTag = new RegExp(`<w:commentRangeStart\\b[^>]*w:id="${id}"[^>]*/>`)
    const endTag = new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${id}"[^>]*/>`)
    const table = tables.find((xml) => startTag.test(xml))
    if (table) {
      const cellParagraphs = elements(table, "p")
      const first = cellParagraphs[0] ?? ""
      const last = cellParagraphs[cellParagraphs.length - 1] ?? ""
      const start = startTag.exec(first)
      const end = endTag.exec(last)
      if (
        !start ||
        !end ||
        paragraphText(first.slice(0, start.index)).trim() ||
        paragraphText(last.slice(end.index + end[0].length)).trim()
      )
        return true
      continue
    }
    const paragraph = paragraphs.find((xml) => commentAnchors(xml).includes(Number(id)))
    if (!paragraph || !covers(paragraph, startTag.exec(paragraph), endTag.exec(paragraph)))
      return true
  }
  return false
}

/** Note types Word uses for the separator lines, never for user content. */
const SEPARATOR_NOTE_TYPES = new Set(["separator", "continuationSeparator", "continuationNotice"])

async function hasRealNotes(
  zip: ZipLike,
  documentXml: string,
  kind: "footnote" | "endnote"
): Promise<boolean> {
  if (new RegExp(`<w:${kind}Reference\\b`).test(documentXml)) return true
  const part = zip.file(`word/${kind}s.xml`)
  if (!part) return false
  const xml = await part.async("string")
  for (const match of xml.matchAll(new RegExp(`<w:${kind}\\b([^>]*?)(/?)>`, "g"))) {
    const type = attr(match[1], "w:type")
    if (!type || !SEPARATOR_NOTE_TYPES.has(type)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Import — numbering (ordered vs bullet)
// ---------------------------------------------------------------------------

type NumberingInfo = Map<string, Map<number, "ordered" | "bullet">>

async function readNumbering(zip: ZipLike): Promise<NumberingInfo> {
  const file = zip.file("word/numbering.xml")
  const info: NumberingInfo = new Map()
  if (!file) return info
  const xml = await file.async("string")
  const abstractFormat = new Map<string, Map<number, "ordered" | "bullet">>()
  for (const match of xml.matchAll(
    /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g
  )) {
    const levels = new Map<number, "ordered" | "bullet">()
    for (const level of elements(match[2], "lvl")) {
      const index = Number(attr(level, "w:ilvl"))
      const format = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(level)?.[1]
      if (Number.isInteger(index) && format)
        levels.set(index, format === "bullet" ? "bullet" : "ordered")
    }
    abstractFormat.set(match[1], levels)
  }
  for (const match of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abstract = /<w:abstractNumId\b[^>]*w:val="(\d+)"/.exec(match[2])
    const format = abstract ? abstractFormat.get(abstract[1]) : undefined
    if (format) {
      const levels = new Map(format)
      for (const override of elements(match[2], "lvlOverride")) {
        const index = Number(attr(override, "w:ilvl"))
        const overridden = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(override)?.[1]
        if (Number.isInteger(index) && overridden)
          levels.set(index, overridden === "bullet" ? "bullet" : "ordered")
      }
      info.set(match[1], levels)
    }
  }
  return info
}

// ---------------------------------------------------------------------------
// Import — comments
// ---------------------------------------------------------------------------

async function readComments(zip: ZipLike): Promise<Map<number, ImportedCommentInfo>> {
  const file = zip.file("word/comments.xml")
  const comments = new Map<number, ImportedCommentInfo>()
  if (!file) return comments
  const xml = await file.async("string")
  for (const match of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = Number.parseInt(attr(match[1], "w:id") ?? "", 10)
    if (!Number.isFinite(id)) continue
    // `commentsExtended.xml` keys a comment by its LAST paragraph's id
    // ([MS-DOCX] 2.5.3.1), which is where Word and the `docx` writer put it.
    const paragraphs = [...match[2].matchAll(/<w:p\b([^>]*)>/g)]
    comments.set(id, {
      author: attr(match[1], "w:author") ?? "",
      text: extractParagraphText(match[2]).join("\n"),
      paraId: paragraphs.length
        ? attr(paragraphs[paragraphs.length - 1][1], "w14:paraId")
        : undefined,
    })
  }
  return comments
}

async function readResolvedCommentParaIds(zip: ZipLike): Promise<Set<string>> {
  const file = zip.file("word/commentsExtended.xml")
  const resolved = new Set<string>()
  if (!file) return resolved
  const xml = await file.async("string")
  for (const match of xml.matchAll(/<w15:commentEx\b([^>]*)\/?>/g)) {
    if (attr(match[1], "w15:done") === "1") {
      const paraId = attr(match[1], "w15:paraId")
      if (paraId) resolved.add(paraId)
    }
  }
  return resolved
}

async function readCoreTitle(zip: ZipLike): Promise<string> {
  const file = zip.file("docProps/core.xml")
  if (!file) return ""
  const xml = await file.async("string")
  const match = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(xml)
  return match ? decodeXml(match[1]).trim() : ""
}

// ---------------------------------------------------------------------------
// Import — body walk
// ---------------------------------------------------------------------------

const TOP_LEVEL_ELEMENT = /<w:(\w+)((?:\s[^>]*?)?)(\/?)>/g

/**
 * Iterate the body's top-level block elements in document order. `w:p` inside
 * tables/comments/textboxes stays unreachable because we jump whole elements;
 * `w:sdt` wrappers are transparent (their `w:sdtContent` children recurse).
 */
function scanBody(
  documentXml: string,
  numbering: NumberingInfo,
  commentIdsByBlock: Map<number, number[]>
): { blocks: DocumentBlock[]; titleParagraph?: { text: string; commentIds: number[] } } {
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml
  const blocks: DocumentBlock[] = []
  let titleParagraph: { text: string; commentIds: number[] } | undefined
  let sawContent = false
  let previousWasCode = false
  const scanRegion = (region: string): void => {
    TOP_LEVEL_ELEMENT.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TOP_LEVEL_ELEMENT.exec(region))) {
      const tag = match[1]
      if (match[3] === "/") continue
      const end = findElementEnd(region, match.index, match[0].length, tag)
      const slice = region.slice(match.index, end)
      if (tag === "p") {
        const block = parseParagraph(slice, numbering, blocks.length)
        if (block) {
          const leading = !sawContent
          sawContent = true
          const previous = blocks[blocks.length - 1]
          if (leading && block.type !== "table" && isTitleParagraph(slice)) {
            titleParagraph = { text: block.text, commentIds: commentAnchors(slice) }
          } else if (block.type === "code" && !block.text.trim() && !previousWasCode) {
            // A blank code line only matters between code lines.
            previousWasCode = false
            TOP_LEVEL_ELEMENT.lastIndex = end
            continue
          } else if (block.type === "code" && previous?.type === "code" && previousWasCode) {
            // Word keeps one paragraph per code line; consecutive code
            // paragraphs are one block, and their comments anchor to it.
            previous.text = `${previous.text}\n${block.text}`
            const anchors = commentAnchors(slice)
            if (anchors.length)
              commentIdsByBlock.set(blocks.length - 1, [
                ...(commentIdsByBlock.get(blocks.length - 1) ?? []),
                ...anchors,
              ])
          } else {
            const anchors = commentAnchors(slice)
            if (anchors.length) commentIdsByBlock.set(blocks.length, anchors)
            blocks.push(block)
          }
          previousWasCode = block.type === "code"
        } else {
          previousWasCode = false
        }
      } else if (tag === "tbl") {
        const block = parseTable(slice, blocks.length)
        previousWasCode = false
        if (block) {
          sawContent = true
          // A comment ranging over cells is on the table; whether it covered
          // all of it is `hasChangedCommentAnchors`'s question.
          const anchors = commentAnchors(slice)
          if (anchors.length) commentIdsByBlock.set(blocks.length, anchors)
          blocks.push(block)
        }
      } else if (tag === "sdt") {
        const content = /<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/.exec(slice)?.[1]
        if (content) scanRegion(content)
      }
      TOP_LEVEL_ELEMENT.lastIndex = end
    }
  }
  scanRegion(body)
  // Blank lines trailing a merged code block are layout, not content.
  for (const block of blocks) if (block.type === "code") block.text = block.text.replace(/\n+$/, "")
  // Block ids follow document order; the consumed title paragraph shifted
  // nothing because ids are assigned from `blocks.length` at parse time.
  return { blocks, titleParagraph }
}

/** A paragraph styled with Word's built-in "Title" style (not "Subtitle"). */
function isTitleParagraph(paragraphXml: string): boolean {
  const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(paragraphXml)?.[1] ?? ""
  return /^title$/i.test(/<w:pStyle\b[^>]*?w:val="([^"]+)"/.exec(pPr)?.[1] ?? "")
}

/** End offset (exclusive) of the element whose open tag starts at `from`. */
function findElementEnd(region: string, from: number, openLength: number, tag: string): number {
  const pattern = new RegExp(`<w:${tag}\\b[^>]*>|</w:${tag}>`, "g")
  pattern.lastIndex = from + openLength
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(region))) {
    if (match[0].startsWith("</")) depth -= 1
    else if (!match[0].endsWith("/>")) depth += 1
    if (depth === 0) return match.index + match[0].length
  }
  return region.length
}

function parseParagraph(
  xml: string,
  numbering: NumberingInfo,
  index: number
): DocumentBlock | null {
  const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(xml)?.[1] ?? ""
  const text = paragraphText(xml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, ""))
  const id = `b${index + 1}`
  const style = /<w:pStyle\b[^>]*?w:val="([^"]+)"/.exec(pPr)?.[1] ?? ""
  // A code paragraph keeps its indentation; an empty one is a blank code line.
  if (CODE_STYLES.test(style)) return { id, type: "code", text: text.replace(/\s+$/, "") }
  if (!text.trim() && !/<w:commentRangeStart\b/.test(xml)) return null
  const headingMatch = /^(?:heading|title|subtitle)\s*([1-6])?$/i.exec(style)
  const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(pPr)?.[1]
  const numId = /<w:numId\b[^>]*w:val="(\d+)"/.exec(pPr)?.[1]
  const ilvl = Number(/<w:ilvl\b[^>]*w:val="(\d+)"/.exec(pPr)?.[1] ?? "0")
  if (/<w:numPr\b/.test(pPr)) {
    const level = Math.min(Math.max(ilvl, 0), MAX_LIST_LEVEL)
    return {
      id,
      type: "list-item",
      ordered: numId ? numbering.get(numId)?.get(ilvl) !== "bullet" : true,
      ...(level ? { level } : {}),
      text,
    }
  }
  if (headingMatch && /^heading/i.test(style))
    return { id, type: "heading", level: Number(headingMatch[1] ?? "1") as HeadingLevel, text }
  if (headingMatch && /^(title|subtitle)$/i.test(style))
    return { id, type: "heading", level: 1, text }
  if (QUOTE_STYLES.test(style)) return { id, type: "quote", text }
  if (outline !== undefined && Number(outline) <= 5)
    return { id, type: "heading", level: (Number(outline) + 1) as HeadingLevel, text }
  return { id, type: "paragraph", text }
}

function parseTable(xml: string, index: number): DocumentBlock | null {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
    const cells: string[] = []
    for (const cellMatch of rowMatch[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
      const paragraphs = extractParagraphText(cellMatch[1])
      cells.push(paragraphs.join("\n"))
    }
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return null
  return { id: `b${index + 1}`, type: "table", rows }
}

/** Ids of comments whose `commentRangeStart` lands inside this element. */
function commentAnchors(xml: string): number[] {
  return [...xml.matchAll(/<w:commentRangeStart\b[^>]*w:id="(\d+)"/g)].map((match) =>
    Number.parseInt(match[1], 10)
  )
}

/**
 * Ordered run-level text extraction: text, tabs, soft line breaks. Field
 * instructions and deleted text never surface as content.
 */
function paragraphText(source: string): string {
  // Deleted (and moved-away) revisions are not current text — their breaks
  // and tabs included, not only their `w:delText`.
  const xml = source.replace(/<w:(del|moveFrom)\b[^>]*>[\s\S]*?<\/w:\1>/g, "")
  const out: string[] = []
  const re =
    /<w:(t|tab|br|noBreakHyphen|softHyphen|delText|instrText)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:\1>)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const tag = match[1]
    if (tag === "delText" || tag === "instrText" || tag === "softHyphen") continue
    if (tag === "tab") out.push("\t")
    else if (tag === "br") out.push("\n")
    else if (tag === "noBreakHyphen") out.push("-")
    else out.push(decodeXml(match[2] ?? ""))
  }
  return out.join("")
}

function extractParagraphText(xml: string): string[] {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) => paragraphText(match[1]).trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Shared XML helpers
// ---------------------------------------------------------------------------

function attr(xml: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(xml)
  return match ? decodeXml(match[1]) : undefined
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

export { DOCX_MIME }

// ---------------------------------------------------------------------------
// Session transcript → DOCX (custom exporter backend)
// ---------------------------------------------------------------------------

export interface TranscriptLabels {
  /** Fallback document title when the session has none. */
  title: string
  /** Role captions used as level-2 headings. */
  user: string
  assistant: string
  system: string
}

interface TranscriptLikeMessage {
  role?: string
  content?: string
  parts?: ReadonlyArray<{ type?: string; text?: string }>
}

export interface TranscriptLikeData {
  session?: { title?: string }
  messages?: TranscriptLikeMessage[]
}

/** Role headings are level 2; a message's own headings nest below them. */
const TRANSCRIPT_ROLE_LEVEL = 2

export async function exportTranscriptDocx(
  data: TranscriptLikeData,
  labels: TranscriptLabels
): Promise<Blob> {
  const bytes = await exportDocx(transcriptModel(data, labels))
  return new Blob([new Uint8Array(bytes)], { type: DOCX_MIME })
}

/**
 * The transcript as a document: one role heading per message, and the
 * message's Markdown (headings, lists, tables, code, quotes) as real blocks
 * instead of paragraphs full of Markdown syntax.
 */
export function transcriptModel(data: TranscriptLikeData, labels: TranscriptLabels): DocumentModel {
  const model = createDocument(data.session?.title?.trim() || labels.title)
  let sequence = 1
  for (const message of data.messages ?? []) {
    const text = transcriptMessageText(message)
    if (!text.trim()) continue
    const role = message.role ?? "assistant"
    model.blocks.push({
      id: `b${sequence++}`,
      type: "heading",
      level: TRANSCRIPT_ROLE_LEVEL,
      text: role === "user" ? labels.user : role === "system" ? labels.system : labels.assistant,
    })
    for (const input of parseMarkdownBlocks(text).blocks) {
      const shifted =
        input.type === "heading"
          ? {
              ...input,
              level: Math.min(input.level + TRANSCRIPT_ROLE_LEVEL, 6) as HeadingLevel,
            }
          : input
      model.blocks.push(materializeBlock(shifted, `b${sequence++}`))
    }
  }
  return model
}

function transcriptMessageText(message: TranscriptLikeMessage): string {
  if (typeof message.content === "string" && message.content.trim()) return message.content
  return (message.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n\n")
}
