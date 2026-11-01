import docsPin from "@/integrations/cognia-docs.json"
import { SUPPORT_DOC_CORPUS, retrieveSupportDocumentation } from "./knowledge"

describe("Support documentation corpus", () => {
  it("bundles the complete bilingual Markdown documentation set", () => {
    expect(SUPPORT_DOC_CORPUS.en.length).toBeGreaterThan(300)
    expect(SUPPORT_DOC_CORPUS.zh.length).toBeGreaterThan(300)
    expect(SUPPORT_DOC_CORPUS.en.some((doc) => doc.path === "index.mdx")).toBe(true)
    expect(SUPPORT_DOC_CORPUS.zh.some((doc) => doc.path === "index.mdx")).toBe(true)
  })

  it("retrieves relevant English documentation with source paths", () => {
    const result = retrieveSupportDocumentation({
      locale: "en",
      query: "How do plugin permissions and capabilities work?",
    })
    expect(result).toContain("/content/docs/en/")
    expect(result.toLowerCase()).toContain("plugin")
    expect(result).toContain(`/blob/${docsPin.revision}/content/docs/en/`)
    expect(result).toMatch(/https:\/\/github\.com\/cognia-labs\/cognia-docs\/blob\/[a-f0-9]{40}\//)
  })

  it("retrieves the Chinese corpus for a Chinese locale", () => {
    const result = retrieveSupportDocumentation({ locale: "zh-CN", query: "如何配置 MCP 服务器？" })
    expect(result).toContain("/content/docs/zh/")
    expect(result).toMatch(/MCP|服务器/)
  })

  it("keeps retrieved context within the requested bound", () => {
    const result = retrieveSupportDocumentation({
      locale: "en",
      query: "architecture runtime plugins workflow mobile diagnostics",
      maxChars: 1_200,
      limit: 20,
    })
    expect(result.length).toBeLessThanOrEqual(1_200)
  })
})

it("keeps empty and unmatched questions useful after the source tree is extracted", () => {
  for (const query of ["", "zxqv991unmatchedterm"]) {
    const result = retrieveSupportDocumentation({ query })
    expect(result).toContain(`/blob/${docsPin.revision}/content/docs/en/`)
    expect(result).toMatch(/index\.mdx|getting-started\.mdx/)
    expect(result.length).toBeLessThanOrEqual(6_000)
  }
})

it("keeps short and multi-document budgets bounded with complete source links", () => {
  const short = retrieveSupportDocumentation({ query: "plugin", maxChars: 40 })
  expect(short).toHaveLength(40)
  const bounded = retrieveSupportDocumentation({ query: "plugin", maxChars: 3_500, limit: 20 })
  expect(bounded.length).toBeLessThanOrEqual(3_500)
  expect(bounded).toContain(`https://github.com/${docsPin.repository}/blob/${docsPin.revision}/`)
})
