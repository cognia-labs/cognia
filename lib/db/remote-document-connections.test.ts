import { createDbTestFixture } from "./test-fixture"
import {
  deleteRemoteDocumentConnection,
  getRemoteDocumentConnection,
  markRemoteDocumentSourceDeleted,
  putRemoteDocumentConnection,
  type RemoteDocumentConnectionRow,
} from "./remote-document-connections"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("retains the capture binding and remote loss until explicitly removed", async () => {
  const row: RemoteDocumentConnectionRow = {
    captureId: crypto.randomUUID(),
    providerId: "plugin:acme/docs",
    connectionRef: "connection" as RemoteDocumentConnectionRow["connectionRef"],
    identityKey: "original-identity",
    capturedAt: 1,
  }
  await putRemoteDocumentConnection(row)
  expect(await getRemoteDocumentConnection(row.captureId)).toEqual(row)
  await markRemoteDocumentSourceDeleted(row.captureId)
  expect(await getRemoteDocumentConnection(row.captureId)).toMatchObject({
    ...row,
    sourceDeletedAt: expect.any(Number),
  })
  await deleteRemoteDocumentConnection(row.captureId)
  expect(await getRemoteDocumentConnection(row.captureId)).toBeUndefined()
  await markRemoteDocumentSourceDeleted(row.captureId)
  expect(await getRemoteDocumentConnection(row.captureId)).toBeUndefined()
})
