import {
  grantInteractiveHtml,
  isInteractiveHtmlGranted,
  offersInteractiveHtml,
  subscribeInteractiveGrants,
} from "./interactive-grant"

const artifact = { id: "html-grant", type: "html" as const, content: "<script>run()</script>" }

it("requires the setting and an explicit grant for this artifact across revisions", () => {
  expect(offersInteractiveHtml(artifact, true)).toBe(true)
  expect(isInteractiveHtmlGranted(artifact, true)).toBe(false)
  const revoke = grantInteractiveHtml(artifact)
  try {
    expect(isInteractiveHtmlGranted(artifact, true)).toBe(true)
    expect(isInteractiveHtmlGranted(artifact, false)).toBe(false)
    expect(isInteractiveHtmlGranted({ ...artifact, id: "other" }, true)).toBe(false)
    expect(
      isInteractiveHtmlGranted({ ...artifact, content: "<script>changed()</script>" }, true)
    ).toBe(true)
    expect(isInteractiveHtmlGranted({ ...artifact, content: "<p>Static</p>" }, true)).toBe(false)
    expect(isInteractiveHtmlGranted({ ...artifact, type: "svg" }, true)).toBe(false)
  } finally {
    revoke()
  }
  expect(isInteractiveHtmlGranted(artifact, true)).toBe(false)
})

it("releases only its own mount and notifies subscribers on grant/revoke", () => {
  const listener = jest.fn()
  const unsubscribe = subscribeInteractiveGrants(listener)
  const first = grantInteractiveHtml(artifact)
  const second = grantInteractiveHtml(artifact)
  first()
  first()
  expect(isInteractiveHtmlGranted(artifact, true)).toBe(true)
  expect(listener).toHaveBeenCalledTimes(3)
  second()
  expect(isInteractiveHtmlGranted(artifact, true)).toBe(false)
  expect(listener).toHaveBeenCalledTimes(4)
  unsubscribe()
  const third = grantInteractiveHtml(artifact)
  third()
  expect(listener).toHaveBeenCalledTimes(4)
})

it("does not offer interactive mode for passive content or SVG", () => {
  expect(offersInteractiveHtml({ ...artifact, content: "<p>Static</p>" }, true)).toBe(false)
  expect(offersInteractiveHtml({ ...artifact, type: "svg" }, true)).toBe(false)
})
