import {
  REMOTE_DOC_PART_KEY,
  projectRemoteDocumentData,
  rememberRemoteDocument,
  stagedRemoteDocument,
  remoteDocumentPersonalMarks,
} from "./remote-document"

const provenance = {
  captureId: "46bc6e38-e2f3-4afc-88d7-998581a43532",
  connectionScoped: true,
  v: 1,
  providerId: "google",
  resourceKind: "doc",
  resourceId: "abcdefghijklmnop1234",
  url: "https://docs.google.com/document/d/abcdefghijklmnop1234/edit",
  title: "Plan",
  fetchedAt: 1,
  completeness: { status: "complete" },
}

it("marks staged personal document attachments as local-person and deduplicates their reads", () => {
  expect(
    remoteDocumentPersonalMarks([
      { remoteDocument: provenance },
      { remoteDocument: { ...provenance, fetchedAt: 2, person: { kind: "service" } } },
      { remoteDocument: { ...provenance, providerId: "lark", url: "" } },
      { remoteDocument: null },
    ])
  ).toEqual([
    { person: { kind: "local-person" }, source: "google-docs", markedAt: 1 },
    { person: { kind: "local-person" }, source: "lark-user", markedAt: 1 },
  ])
})

it("binds intake provenance to File identity, never to a filename", () => {
  const file = new File(["body"], "Plan.md")
  rememberRemoteDocument(file, provenance)
  expect(stagedRemoteDocument(file)?.resourceId).toBe("abcdefghijklmnop1234")
  expect(stagedRemoteDocument(new File(["other"], "Plan.md"))).toBeUndefined()
})

it.each([true, false])(
  "projects parts and draft records without retrieval authority (keep=%s)",
  (keep) => {
    const injected = {
      ...provenance,
      connectionRef: "private-connection",
      identityKey: "private-identity",
      accountId: "secret",
      authorizationEpoch: "epoch",
      accountBinding: { accountId: "secret" },
    }
    const source = {
      parts: [{ type: "file", [REMOTE_DOC_PART_KEY]: injected }],
      attachments: [{ remoteDocument: injected }],
    }
    const projected = projectRemoteDocumentData(source, keep)
    expect(JSON.stringify(projected)).not.toMatch(
      /accountId|authorizationEpoch|accountBinding|secret|connectionRef|identityKey|private-connection|private-identity/
    )
    expect(projected.parts[0][REMOTE_DOC_PART_KEY]).toEqual(keep ? provenance : undefined)
    expect(source.parts[0][REMOTE_DOC_PART_KEY].accountId).toBe("secret")
  }
)

import { runInNewContext } from "node:vm"
it("sanitizes persisted plain records from another JavaScript realm", () => {
  const source = runInNewContext(
    `({parts:[{remoteDocument:${JSON.stringify({ ...provenance, accountId: "private-account" })}}]})`
  )
  expect(projectRemoteDocumentData(source, true).parts[0].remoteDocument).not.toHaveProperty(
    "accountId"
  )
})
it("preserves untouched rows and binary draft caches by identity", () => {
  const bytes = new Uint8Array([1, 2]),
    row = { attachments: [{ bytes, name: "local" }] }
  expect(projectRemoteDocumentData(row, false)).toBe(row)
})
