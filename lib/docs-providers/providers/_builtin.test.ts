import { BUILTIN_DOCS_PROVIDERS } from "./_builtin"
import { larkDocsProvider } from "./lark"
import { googleDocsProvider } from "./google"

it("lists the built-in providers in registration order", () => {
  expect(BUILTIN_DOCS_PROVIDERS).toEqual([larkDocsProvider, googleDocsProvider])
})
