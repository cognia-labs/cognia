/** @jest-environment jsdom */
import {
  onComposerDocumentRequest,
  requestComposerDocument,
  COMPOSER_DOCUMENT_REQUEST_EVENT,
} from "./composer-document-request"
const doc = {
  providerId: "google",
  kind: "doc" as const,
  id: "abcdefghijklmnop1234",
  title: "Plan",
  accountBinding: { accountId: "a", authorizationEpoch: "v1" },
}
it("round trips to the owning composer once, leaving other sessions alone", () => {
  const owner = jest.fn(),
    other = jest.fn(),
    duplicate = jest.fn()
  const stops = [
    onComposerDocumentRequest("other", other),
    onComposerDocumentRequest("s", owner),
    onComposerDocumentRequest("s", duplicate),
  ]
  expect(requestComposerDocument({ sessionId: "s", doc })).toBe(true)
  expect(owner).toHaveBeenCalledWith(doc)
  expect(other).not.toHaveBeenCalled()
  expect(duplicate).not.toHaveBeenCalled()
  stops.forEach((stop) => stop())
  expect(requestComposerDocument({ sessionId: "s", doc })).toBe(false)
})
it("ignores malformed requests and requests without verified account hints", () => {
  const handler = jest.fn(),
    stop = onComposerDocumentRequest("s", handler)
  for (const detail of [
    null,
    { sessionId: "s", doc: {} },
    { sessionId: "s", doc: { ...doc, accountBinding: undefined } },
  ]) {
    window.dispatchEvent(new CustomEvent(COMPOSER_DOCUMENT_REQUEST_EVENT, { detail }))
  }
  expect(handler).not.toHaveBeenCalled()
  stop()
})
