import { larkDocumentUrls } from "./document-url"

const target = (raw: string) => larkDocumentUrls.target(new URL(raw))

it("recognises Feishu and Lark documents on first-party hosts", () => {
  expect(target("https://acme.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWx?from=chat#h1")).toEqual({
    resourceKind: "doc",
    resourceId: "AbCdEfGhIjKlMnOpQrStUvWx",
    url: "https://acme.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWx",
  })
  expect(target("https://acme.larksuite.com/sheets/AbCdEfGhIjKlMnOpQrStUvWx")).toMatchObject({
    resourceKind: "sheet",
  })
})

it("leaves other hosts and custom portals to plugin providers", () => {
  expect(target("https://docs.google.com/document/d/AbCdEfGhIjKlMnOpQrStUvWx/edit")).toBeNull()
  expect(target("https://wiki.example.com/docx/AbCdEfGhIjKlMnOpQrStUvWx")).toBeNull()
  expect(target("https://acme.feishu.cn/not-a-document")).toBeNull()
})

it("keeps the legacy-vs-docx hint and accepts every kind", () => {
  expect(larkDocumentUrls.keepsSourceType).toBe(true)
  expect(larkDocumentUrls.kinds).toBeUndefined()
  expect(larkDocumentUrls.canonicalUrl).toBeUndefined()
})
