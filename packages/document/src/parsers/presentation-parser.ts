/**
 * Presentation Parser - Extract text content from PowerPoint (.pptx) files.
 * Uses JSZip to read slide XML and metadata.
 */

import { DEFAULT_DOCUMENT_LIMITS, DocumentLimitError } from "../limits"
import {
  childElements,
  findElement,
  findElements,
  isElement,
  parseXmlTree,
  textContent,
  type XmlNode,
} from "./xml-tree"

export interface PresentationParseResult {
  text: string
  slideCount: number
  slides: PresentationSlide[]
  metadata: PresentationMetadata
}

export interface PresentationSlide {
  slideNumber: number
  title?: string
  text: string
}

export interface PresentationMetadata {
  title?: string
  author?: string
  lastModifiedBy?: string
  created?: Date
  modified?: Date
}

/**
 * Parse PPTX data from ArrayBuffer.
 *
 * Slides are read in presentation order (`ppt/presentation.xml`'s slide list,
 * resolved through its relationships), which is what the user sees and what
 * slide numbers mean; the part names (`slide7.xml`) are storage, and a deck
 * whose slides were reordered keeps its old part names. A slide with no text
 * (a picture, a chart) keeps its position with empty text, so slide N is
 * always the user's slide N.
 */
export async function parsePresentation(data: ArrayBuffer): Promise<PresentationParseResult> {
  const JSZip = (await import("jszip")).default

  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new Error("Failed to parse presentation file. Ensure the file is a valid .pptx.")
  }

  const slidePaths = await presentationSlidePaths(zip)

  if (slidePaths.length === 0) {
    throw new Error("No slide content found in presentation file.")
  }
  if (slidePaths.length > DEFAULT_DOCUMENT_LIMITS.maxSlides) {
    throw new DocumentLimitError("slides", DEFAULT_DOCUMENT_LIMITS.maxSlides, slidePaths.length)
  }

  const slides: PresentationSlide[] = []

  for (const [index, slidePath] of slidePaths.entries()) {
    const slideFile = zip.file(slidePath)
    const xml = slideFile ? await slideFile.async("string") : ""
    const slideText = xml ? await extractSlideText(xml) : ""
    const title = slideText
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
    slides.push({
      slideNumber: index + 1,
      ...(title ? { title } : {}),
      text: slideText,
    })
  }

  if (!slides.some((slide) => slide.text)) {
    throw new Error("No readable text content found in presentation file.")
  }

  const metadata = await extractPresentationMetadata(zip)
  const text = slides
    .filter((slide) => slide.text)
    .map((slide) => `## Slide ${slide.slideNumber}\n${slide.text}`)
    .join("\n\n")

  return {
    text,
    slideCount: slides.length,
    slides,
    metadata,
  }
}

/** Relationship type of a presentation's slide parts. */
const SLIDE_RELATIONSHIP = /\/relationships\/slide$/

/**
 * Slide part paths in presentation order. A package without a readable slide
 * list (not a PowerPoint-written file) falls back to part-number order, the
 * only order it carries.
 */
async function presentationSlidePaths(zip: ZipLike & { files: Record<string, unknown> }) {
  const partOrder = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => getSlideNumber(a) - getSlideNumber(b))
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string")
  const relsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")
  if (!presentationXml || !relsXml) return partOrder

  const rels = await parseXmlTree(relsXml)
  const targets = new Map<string, string>()
  for (const rel of findElements(rels, "Relationship")) {
    const { Id: id, Type: type, Target: target, TargetMode: mode } = rel.attribs
    if (id && target && mode !== "External" && SLIDE_RELATIONSHIP.test(type ?? "")) {
      targets.set(id, resolvePartPath("ppt", target))
    }
  }
  const presentation = await parseXmlTree(presentationXml)
  const list = findElement(presentation, "p:sldIdLst")
  if (!list) return partOrder
  const ordered = childElements(list, "p:sldId")
    .map((slide) => targets.get(slide.attribs["r:id"] ?? ""))
    .filter((path): path is string => Boolean(path && zip.file(path)))
  return ordered.length > 0 ? ordered : partOrder
}

/** A relationship target resolved against its source part's folder. */
function resolvePartPath(baseFolder: string, target: string): string {
  const segments = target.startsWith("/") ? [] : baseFolder.split("/")
  for (const segment of target.replace(/^\//, "").split("/")) {
    if (segment === "..") segments.pop()
    else if (segment && segment !== ".") segments.push(segment)
  }
  return segments.join("/")
}

/**
 * Parse PPTX from File object.
 */
export async function parsePresentationFile(file: File): Promise<PresentationParseResult> {
  const buffer = await file.arrayBuffer()
  return parsePresentation(buffer)
}

/**
 * Build embedding-friendly text from parsed presentation result.
 */
export function extractPresentationEmbeddableContent(result: PresentationParseResult): string {
  const parts: string[] = []

  if (result.metadata.title) {
    parts.push(`Title: ${result.metadata.title}`)
  }
  if (result.metadata.author) {
    parts.push(`Author: ${result.metadata.author}`)
  }

  parts.push(result.text)
  return parts.join("\n\n")
}

function getSlideNumber(path: string): number {
  const match = path.match(/slide(\d+)\.xml$/i)
  return match ? Number(match[1]) : 0
}

/**
 * A slide's text, one line per paragraph (`a:p`), in shape-tree order. Runs
 * (`a:r`) and fields (`a:fld`) of one paragraph join without a break; `a:br`
 * is a line break inside it.
 */
async function extractSlideText(xml: string): Promise<string> {
  const tree = await parseXmlTree(xml)
  const lines: string[] = []
  for (const paragraph of findElements(tree, "a:p")) {
    let line = ""
    const visit = (node: XmlNode) => {
      for (const child of node.children ?? []) {
        if (isElement(child, "a:t")) line += textContent(child)
        else if (isElement(child, "a:br")) line += "\n"
        else if (isElement(child)) visit(child)
      }
    }
    visit(paragraph)
    const trimmed = line.trim()
    if (trimmed) lines.push(trimmed)
  }
  return lines.join("\n").trim()
}

interface ZipTextFileLike {
  async: (type: "string") => Promise<string>
}

interface ZipLike {
  file: (path: string) => ZipTextFileLike | null
}

async function extractPresentationMetadata(zip: ZipLike): Promise<PresentationMetadata> {
  const coreFile = zip.file("docProps/core.xml")
  if (!coreFile) {
    return {}
  }

  const xml = await coreFile.async("string")

  return {
    title: extractTagText(xml, "title"),
    author: extractTagText(xml, "creator"),
    lastModifiedBy: extractTagText(xml, "lastModifiedBy"),
    created: parseXmlDate(extractTagText(xml, "created")),
    modified: parseXmlDate(extractTagText(xml, "modified")),
  }
}

function extractTagText(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i")
  const match = xml.match(regex)
  if (!match) {
    return undefined
  }
  const value = decodeXmlEntities(match[1]).trim()
  return value || undefined
}

function parseXmlDate(value?: string): Date | undefined {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}
