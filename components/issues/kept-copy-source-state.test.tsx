/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react"
import { useMemo } from "react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { captureKeptCopyConnection } from "@/lib/docs-providers/kept-copy-source"
import { markRemoteDocumentSourceDeleted } from "@/lib/db/remote-document-connections"
import { tombstoneAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import type { IssueProject, IssueProjectResource } from "@/types/issues"
import { IssueResourceSourceState, useIssueSyncAvailability } from "./kept-copy-source-state"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
function Surface({ resource }: { resource: IssueProjectResource }) {
  const projects = useMemo(() => [{ resources: [resource] } as IssueProject], [resource])
  const availability = useIssueSyncAvailability(projects)
  return (
    <>
      <IssueResourceSourceState resource={resource} />
      <button disabled={!availability.canSync}>{availability.reason ?? "sync.now"}</button>
    </>
  )
}

it("reactively disables sync on disconnect, restores it by identity and shows confirmed deletion", async () => {
  const connection = {
    id: "original",
    status: "connected",
    identityKey: "same",
    revision: 1,
  } as AuthConnectionRow
  await getDb().authConnections.put(connection)
  const captureId = await captureKeptCopyConnection({
    providerId: "github",
    connectionRef: connection.id,
    revision: 1,
  })
  render(<Surface resource={{ kind: "github-repo", repoFullName: "o/r", addedAt: 1, captureId }} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "sync.now" })).toBeEnabled())
  await act(async () => {
    await getDb().authConnections.put(tombstoneAuthConnection(connection, "tombstoned"))
  })
  expect(await screen.findByRole("button", { name: "sync.sourceDisconnected" })).toBeDisabled()
  expect(screen.getAllByText("sync.sourceDisconnected")).toHaveLength(2)
  await act(async () => {
    await getDb().authConnections.put({ ...connection, id: "restored" as never })
  })
  await waitFor(() => expect(screen.getByRole("button", { name: "sync.now" })).toBeEnabled())
  await act(async () => {
    await markRemoteDocumentSourceDeleted(captureId)
  })
  expect(await screen.findByRole("button", { name: "sync.sourceDeleted" })).toBeDisabled()
  expect(screen.getAllByText("sync.sourceDeleted")).toHaveLength(2)
})

it("shows no source state for legacy resources and allows their sync", async () => {
  render(<Surface resource={{ kind: "github-repo", repoFullName: "legacy/r", addedAt: 1 }} />)
  expect(screen.getByRole("button", { name: "sync.now" })).toBeEnabled()
  expect(screen.queryByText("sync.sourceDisconnected")).not.toBeInTheDocument()
  expect(screen.queryByText("sync.sourceDeleted")).not.toBeInTheDocument()
})
