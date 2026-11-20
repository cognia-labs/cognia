import {
  childElements,
  findElement,
  findElements,
  isElement,
  parseXmlTree,
  textContent,
} from "./xml-tree"

describe("xml-tree", () => {
  it("parses self-closing elements, attributes and decoded character data", async () => {
    const tree = await parseXmlTree(
      `<?xml version="1.0"?><root xmlns:a="urn:a"><a:t xml:space="preserve">x &amp; y</a:t><a:br/><a:t>&#x4E2D;</a:t></root>`
    )
    const root = findElement(tree, "root")!

    expect(childElements(root).map((child) => child.name)).toEqual(["a:t", "a:br", "a:t"])
    expect(childElements(root, "a:t").map(textContent)).toEqual(["x & y", "中"])
    expect(childElements(root, "a:t")[0].attribs["xml:space"]).toBe("preserve")
    expect(isElement(childElements(root)[1], "a:br")).toBe(true)
  })

  it("finds matches in document order without descending into a match", async () => {
    const tree = await parseXmlTree("<r><p>1<p>nested</p></p><g><p>2</p></g></r>")

    expect(findElements(tree, "p").map(textContent)).toEqual(["1nested", "2"])
    expect(findElement(tree, "g")?.name).toBe("g")
    expect(findElement(tree, "missing")).toBeUndefined()
  })

  it("never expands DTD entities", async () => {
    const tree = await parseXmlTree(
      `<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><r>&b;</r>`
    )

    expect(textContent(findElement(tree, "r")!)).not.toContain("aaaaaaaaaa")
  })
})
