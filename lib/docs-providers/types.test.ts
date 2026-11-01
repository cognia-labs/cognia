import { DocsProviderError, type RemoteDocRef } from "./types"
import { DocsProviderError as PublicDocsProviderError } from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"

it("retains a provider's source type when several document types share a picker kind", () => {
  const ref: RemoteDocRef = {
    providerId: "lark",
    kind: "doc",
    id: "opaqueId",
    sourceType: "docx",
    title: "Plan",
  }
  const restored = JSON.parse(JSON.stringify(ref)) as RemoteDocRef
  expect(restored.sourceType).toBe("docx")
  expect(restored.kind).toBe("doc")
})

describe("DocsProviderError", () => {
  it("recognizes errors created by public plugin providers at the Host boundary", () => {
    const error = new PublicDocsProviderError("noPermission")
    expect(error).toBeInstanceOf(DocsProviderError)
    expect(error.code).toBe("noPermission")
  })

  it("keeps the code addressable for the i18n lookup", () => {
    const err = new DocsProviderError("noPermission")
    expect(err.code).toBe("noPermission")
    expect(err.name).toBe("DocsProviderError")
    expect(err).toBeInstanceOf(Error)
  })

  it("carries params through for message interpolation", () => {
    const err = new DocsProviderError("notAuthorized", { account: "Acme" })
    expect(err.params).toEqual({ account: "Acme" })
  })

  it("puts a reason in the message so logs are readable without the params", () => {
    expect(new DocsProviderError("network", { reason: "socket hang up" }).message).toBe(
      "network: socket hang up"
    )
  })

  it("falls back to the bare code when there is no reason", () => {
    expect(new DocsProviderError("empty").message).toBe("empty")
    expect(new DocsProviderError("empty", { title: "Doc" }).message).toBe("empty")
  })
})
