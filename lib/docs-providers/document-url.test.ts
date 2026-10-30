import { classifyCloudDocumentUrl, cloudDocumentTargetFromRef } from "./document-url"

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
