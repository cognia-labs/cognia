import {
  parseRemoteDocumentProvenance,
  remoteDocumentProvenance,
  type RemoteDocumentProvenanceV1,
} from "./document-provenance"
import type { RemoteDocContent } from "./types"

const LARK_ID = "doxcnAbCdEfGhIjKlMnOpQr"
const GOOGLE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz"

const valid: RemoteDocumentProvenanceV1 = {
  v: 1,
  providerId: "lark",
  resourceKind: "doc",
  resourceId: LARK_ID,
  url: `https://acme.feishu.cn/docx/${LARK_ID}`,
  title: "Quarterly report",
  fetchedAt: 1_790_000_000_000,
  completeness: { status: "complete" },
}

describe("parseRemoteDocumentProvenance", () => {
  it("round-trips a valid record", () => {
    expect(parseRemoteDocumentProvenance(valid)).toEqual(valid)
  })

  it("drops every field outside the whitelist, including retrieval identity", () => {
    const parsed = parseRemoteDocumentProvenance({
      ...valid,
      accountId: "acct-1",
      authorizationEpoch: "e1",
      accountBinding: { accountId: "acct-1" },
      profileId: "cognia-document-viewer",
      token: "secret",
    })
    expect(parsed).toEqual(valid)
    expect(Object.keys(parsed!).sort()).toEqual(
      [
        "completeness",
        "fetchedAt",
        "providerId",
        "resourceId",
        "resourceKind",
        "title",
        "url",
        "v",
      ].sort()
    )
  })

  it.each([
    ["unknown version", { ...valid, v: 2 }],
    ["unknown provider", { ...valid, providerId: "notion" }],
    ["unknown kind", { ...valid, resourceKind: "slides" }],
    ["empty id", { ...valid, resourceId: "" }],
    ["oversized id", { ...valid, resourceId: "x".repeat(300) }],
    ["non-string title", { ...valid, title: 1 }],
    ["bad time", { ...valid, fetchedAt: Number.NaN }],
    ["zero time", { ...valid, fetchedAt: 0 }],
    ["bad completeness", { ...valid, completeness: { status: "unknown" } }],
    ["partial without reasons", { ...valid, completeness: { status: "partial", reasons: [] } }],
    ["array", [valid]],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(parseRemoteDocumentProvenance(value)).toBeNull()
  })

  it("keeps only known partial reasons", () => {
    expect(
      parseRemoteDocumentProvenance({
        ...valid,
        completeness: { status: "partial", reasons: ["budget", "made-up", "budget"] },
      })?.completeness
    ).toEqual({ status: "partial", reasons: ["budget"] })
  })

  it.each([
    ["a spoofed host", `https://feishu.cn.evil.example/docx/${LARK_ID}`],
    ["plain http", `http://acme.feishu.cn/docx/${LARK_ID}`],
    ["credentials", `https://user:pass@acme.feishu.cn/docx/${LARK_ID}`],
    ["another resource", "https://acme.feishu.cn/docx/doxcnSomethingElse12345"],
    ["a script scheme", "javascript:alert(1)"],
  ])("blanks an untrusted address (%s) instead of keeping it", (_label, url) => {
    expect(parseRemoteDocumentProvenance({ ...valid, url })?.url).toBe("")
  })

  it("canonicalizes the address and strips query and fragment", () => {
    expect(
      parseRemoteDocumentProvenance({ ...valid, url: `${valid.url}?code=abc&state=xyz#heading` })
        ?.url
    ).toBe(valid.url)
  })

  it("keeps only an explicit truncated flag", () => {
    expect(parseRemoteDocumentProvenance({ ...valid, truncated: true })?.truncated).toBe(true)
    expect(parseRemoteDocumentProvenance({ ...valid, truncated: "yes" })).not.toHaveProperty(
      "truncated"
    )
  })
})

it("keeps a Lark doc/docx source type and drops any other value", () => {
  expect(parseRemoteDocumentProvenance({ ...valid, sourceType: "docx" })?.sourceType).toBe("docx")
  expect(parseRemoteDocumentProvenance({ ...valid, sourceType: "sheet" })).not.toHaveProperty(
    "sourceType"
  )
  expect(
    parseRemoteDocumentProvenance({
      ...valid,
      providerId: "google",
      resourceId: GOOGLE_ID,
      url: "",
      sourceType: "docx",
    })
  ).not.toHaveProperty("sourceType")
})

describe("remoteDocumentProvenance", () => {
  const content = (over: Partial<RemoteDocContent> = {}): RemoteDocContent => ({
    ref: {
      providerId: "google",
      kind: "sheet",
      id: GOOGLE_ID,
      title: "Budget",
      accountBinding: { accountId: "acct-1", authorizationEpoch: "e1" },
    },
    title: "Budget 2026",
    text: "a,b",
    format: "csv",
    ...over,
  })

  it("builds a record from a fetched body without its account binding", () => {
    const record = remoteDocumentProvenance(content(), 42)
    expect(record).toEqual({
      v: 1,
      providerId: "google",
      resourceKind: "sheet",
      resourceId: GOOGLE_ID,
      url: `https://docs.google.com/spreadsheets/d/${GOOGLE_ID}/edit`,
      title: "Budget 2026",
      fetchedAt: 42,
      completeness: { status: "complete" },
    })
    expect(JSON.stringify(record)).not.toContain("acct-1")
  })

  it("maps a truncated body without completeness to a partial record", () => {
    expect(remoteDocumentProvenance(content({ truncated: true }), 42)).toMatchObject({
      completeness: { status: "partial", reasons: ["upstream-truncated"] },
      truncated: true,
    })
  })

  it("keeps the provider's own completeness", () => {
    expect(
      remoteDocumentProvenance(
        content({ completeness: { status: "partial", reasons: ["inaccessible-block"] } }),
        42
      )?.completeness
    ).toEqual({ status: "partial", reasons: ["inaccessible-block"] })
  })

  it("leaves a Lark search hit without a known host addressless", () => {
    expect(
      remoteDocumentProvenance(
        {
          ref: { providerId: "lark", kind: "doc", id: LARK_ID, title: "Report" },
          title: "Report",
          text: "body",
          format: "text",
        },
        42
      )?.url
    ).toBe("")
  })

  it("returns null for providers without document tabs", () => {
    expect(
      remoteDocumentProvenance(
        content({ ref: { providerId: "notion", kind: "doc", id: "abc", title: "N" } }),
        42
      )
    ).toBeNull()
  })
})
