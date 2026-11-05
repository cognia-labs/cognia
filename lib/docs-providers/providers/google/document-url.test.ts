import { googleDocumentUrls } from "./document-url"
import { googleDocUrl } from "./url"

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
const target = (raw: string) => googleDocumentUrls.target(new URL(raw))

it("recognises Docs and Sheets on docs.google.com with a canonical URL", () => {
  expect(target(`https://docs.google.com/document/d/${ID}/edit?usp=sharing`)).toEqual({
    resourceKind: "doc",
    resourceId: ID,
    url: googleDocUrl("doc", ID),
  })
})

it("keeps only a well-formed tab or gid selector", () => {
  const sheet = target(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`)
  expect(new URL(sheet!.url).searchParams.get("gid")).toBe("42")
  const doc = target(`https://docs.google.com/document/d/${ID}/edit?tab=t.0&x=1`)
  expect(new URL(doc!.url).searchParams.get("tab")).toBe("t.0")
  expect(new URL(doc!.url).searchParams.get("x")).toBeNull()
  const bad = target(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=abc`)
  expect(new URL(bad!.url).searchParams.get("gid")).toBeNull()
})

it("leaves other hosts and unparsable paths alone", () => {
  expect(target(`https://drive.google.com/file/d/${ID}/view`)).toBeNull()
  expect(target("https://docs.google.com/forms/d/x/viewform")).toBeNull()
})

it("limits dock tabs to docs and sheets and builds canonical URLs", () => {
  expect(googleDocumentUrls.kinds).toEqual(["doc", "sheet"])
  expect(googleDocumentUrls.canonicalUrl!("sheet", ID)).toBe(googleDocUrl("sheet", ID))
})
