/**
 * A parsed XML tree for the package parsers (OpenDocument, PPTX).
 *
 * The parsers used to scan package XML with regular expressions, which cannot
 * see a self-closing element (`<table:table-cell/>`), an element carrying
 * attributes they did not expect (`<a:t xml:space="preserve">`), or where a
 * nested element ends. A tree reads all three the way the format defines them.
 *
 * cheerio (htmlparser2 in XML mode) is the parser: it is already this
 * package's HTML dependency, runs the same in the webview, Node and the
 * mobile bundle, and never resolves DTDs or external entities, so a document
 * cannot pull in a file or expand an entity bomb.
 */

/** One node of the tree: an element (`tag`), text, or anything else. */
export interface XmlNode {
  type: string
  /** Qualified element name as written (`table:table-cell`). */
  name?: string
  attribs?: Record<string, string>
  children?: XmlNode[]
  /** Character data of a text node, entities already decoded. */
  data?: string
}

/** An element node. */
export interface XmlElement extends XmlNode {
  type: "tag"
  name: string
  attribs: Record<string, string>
  children: XmlNode[]
}

/** Parse `xml` into its document node. */
export async function parseXmlTree(xml: string): Promise<XmlNode> {
  const cheerio = await import("cheerio")
  const $ = cheerio.load(xml, { xml: true })
  return $.root()[0] as unknown as XmlNode
}

export function isElement(node: XmlNode | undefined, name?: string): node is XmlElement {
  return node?.type === "tag" && (name === undefined || node.name === name)
}

/** Element children of `node`, optionally only those named `name`. */
export function childElements(node: XmlNode, name?: string): XmlElement[] {
  return (node.children ?? []).filter((child): child is XmlElement => isElement(child, name))
}

/** The first element named `name` at any depth below `node`, in document order. */
export function findElement(node: XmlNode, name: string): XmlElement | undefined {
  for (const child of node.children ?? []) {
    if (isElement(child, name)) return child
    const nested = findElement(child, name)
    if (nested) return nested
  }
  return undefined
}

/**
 * Every element named `name` below `node`, in document order. A match's own
 * subtree is not searched, so nested matches do not appear twice.
 */
export function findElements(node: XmlNode, name: string): XmlElement[] {
  const found: XmlElement[] = []
  const visit = (current: XmlNode) => {
    for (const child of current.children ?? []) {
      if (isElement(child, name)) found.push(child)
      else visit(child)
    }
  }
  visit(node)
  return found
}

/** All character data below `node`, concatenated in document order. */
export function textContent(node: XmlNode): string {
  if (node.type === "text") return node.data ?? ""
  return (node.children ?? []).map(textContent).join("")
}
