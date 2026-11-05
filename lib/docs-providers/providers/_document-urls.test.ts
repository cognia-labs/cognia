import { BUILTIN_DOCUMENT_URLS } from "./_document-urls"
import { BUILTIN_DOCS_PROVIDERS } from "./_builtin"

it("has one URL scheme per built-in provider, in the same order", () => {
  expect(BUILTIN_DOCUMENT_URLS.map((scheme) => scheme.providerId)).toEqual(
    BUILTIN_DOCS_PROVIDERS.map((provider) => provider.id)
  )
})
