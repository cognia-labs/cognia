import { loadPortCollection } from "@/lib/modules/ports"
import { BUILTIN_DOCUMENT_URLS } from "./_document-urls"

it("has one URL scheme per member of the docs-provider port", async () => {
  const { members, failures } = await loadPortCollection("docs-provider")
  expect(failures).toEqual([])
  expect(BUILTIN_DOCUMENT_URLS.map((scheme) => scheme.providerId).sort()).toEqual(
    members.map((member) => member.port.id).sort()
  )
})
