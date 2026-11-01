import { classifyCloudDocumentUrl, cloudDocumentTargetFromRef } from "./document-url"
import { registerDocsProvider } from "./registry"

const id = "abcdefghijklmnop1234"

describe("cloud document URLs", () => {
  it.each([
    `https://team.feishu.cn/docx/${id}?token=secret#x`,
    `https://feishu.cn/wiki/${id}`,
    `https://a.larksuite.com/sheets/${id}`,
    `https://a.larkoffice.com/base/${id}`,
  ])("accepts first-party Lark resources: %s", (url) => {
    expect(classifyCloudDocumentUrl(url)).toMatchObject({ providerId: "lark", resourceId: id })
    expect(classifyCloudDocumentUrl(url)?.url).not.toMatch(/[?#]/)
  })
  it.each([
    `https://feishu.cn.evil.com/docx/${id}`,
    `https://evil.com/docx/${id}`,
    `http://team.feishu.cn/docx/${id}`,
    `https://user@team.feishu.cn/docx/${id}`,
    `https://@team.feishu.cn/docx/${id}`,
    `https://team.feishu.cn:444/docx/${id}`,
    "javascript:alert(1)",
    `https://docs.google.com/presentation/d/${id}`,
    "https://docs.google.com/document/d/short",
  ])("rejects %s", (url) => expect(classifyCloudDocumentUrl(url)).toBeNull())
  it("keeps only well-formed sheet and document navigation parameters", () => {
    expect(
      classifyCloudDocumentUrl(
        `https://docs.google.com/spreadsheets/d/${id}/edit?code=secret#gid=42`
      )?.url
    ).toBe(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=42`)
    expect(
      classifyCloudDocumentUrl(
        `https://docs.google.com/document/d/${id}/edit?tab=t.abc&state=secret`
      )?.url
    ).toBe(`https://docs.google.com/document/d/${id}/edit?tab=t.abc`)
  })
  it("never guesses a tenant host or trusts a mismatched URL", () => {
    const ref = { providerId: "lark", kind: "doc" as const, id, title: "Report" }
    expect(cloudDocumentTargetFromRef("lark", ref)?.url).toBe("")
    expect(
      cloudDocumentTargetFromRef("lark", { ...ref, url: `https://evil.com/docx/${id}` })?.url
    ).toBe("")
    expect(cloudDocumentTargetFromRef("other", ref)).toBeNull()
    expect(cloudDocumentTargetFromRef("google", { ...ref, providerId: "google" })?.url).toBe(
      `https://docs.google.com/document/d/${id}/edit`
    )
    expect(cloudDocumentTargetFromRef("lark", { ...ref, sourceType: "docx" })).toMatchObject({
      url: "",
      sourceType: "docx",
    })
  })
})

it("recognizes a plugin only on exact declared HTTPS origins, including a declared port", () => {
  const providerId = "plugin:url-test/docs"
  const origin = "https://docs.example.test:8443"
  const dispose = registerDocsProvider({
    id: providerId,
    mentionPrefix: "url-test.docs:",
    kinds: ["doc"],
    hosts: ["web"],
    urlOrigins: [origin],
    listAccounts: async () => [],
    matchRef: (url) => ({ kind: "doc", id, url }),
    fetch: jest.fn(),
  })
  const url = `${origin}/report`
  expect(classifyCloudDocumentUrl(url)).toEqual({
    providerId,
    resourceKind: "doc",
    resourceId: id,
    url,
  })
  expect(
    cloudDocumentTargetFromRef(providerId, { providerId, id, kind: "doc", title: "Report", url })
      ?.url
  ).toBe(url)
  expect(
    cloudDocumentTargetFromRef(providerId, { providerId, id, kind: "sheet", title: "Report", url })
  ).toBeNull()
  for (const address of [
    "https://docs.example.test/report",
    "https://docs.example.test:8444/report",
    "https://docs.example.test.evil:8443/report",
    "http://docs.example.test:8443/report",
  ])
    expect(classifyCloudDocumentUrl(address)).toBeNull()
  dispose()
  expect(classifyCloudDocumentUrl(url)).toBeNull()
  expect(
    cloudDocumentTargetFromRef(providerId, { providerId, id, kind: "doc", title: "Report", url })
      ?.url
  ).toBe("")
})

it.each(["invalid-url", "https://evil.example/report"])(
  "discards a plugin's invalid canonical address: %s",
  (canonical) => {
    const dispose = registerDocsProvider({
      id: "plugin:canonical/docs",
      mentionPrefix: "canonical.docs:",
      kinds: ["doc"],
      hosts: ["web"],
      urlOrigins: ["https://docs.example.test"],
      listAccounts: async () => [],
      matchRef: () => ({ kind: "doc", id, url: canonical }),
      fetch: jest.fn(),
    })
    expect(classifyCloudDocumentUrl("https://docs.example.test/report")).toBeNull()
    dispose()
  }
)
