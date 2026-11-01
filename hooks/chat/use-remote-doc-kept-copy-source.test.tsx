import { act, renderHook, waitFor } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { registerDocsProvider } from "@/lib/docs-providers/registry"
import { useKeptCopySource } from "./use-remote-doc-kept-copy-source"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const provenance = {
  v: 1,
  captureId: "46bc6e38-e2f3-4afc-88d7-998581a43532",
  connectionScoped: true,
  providerId: "plugin:kept/docs",
  resourceKind: "resource",
  resourceId: "report",
  url: "",
  title: "Report",
  fetchedAt: 1,
  completeness: { status: "complete" },
}

it("leaves legacy copies without a badge or a connection gate", () => {
  const { result } = renderHook(() => useKeptCopySource(undefined))
  expect(result.current).toEqual({ status: "unknown", canReopen: true })
})

it("reacts to local capture, connection and provider changes without publishing identity", async () => {
  const dispose = registerDocsProvider({
    id: provenance.providerId,
    mentionPrefix: "kept.docs:",
    kinds: ["resource"],
    hosts: ["web"],
    listAccounts: async () => [],
    matchRef: () => null,
    fetch: jest.fn(),
  })
  try {
    const { result } = renderHook(() => useKeptCopySource(provenance))
    expect(result.current.canReopen).toBe(false)
    await waitFor(() => expect(result.current.status).toBe("not-on-this-device"))
    await act(async () => {
      await getDb().remoteDocumentConnections.put({
        captureId: provenance.captureId,
        providerId: provenance.providerId,
        connectionRef: "original",
        identityKey: "identity",
        capturedAt: 1,
      } as never)
    })
    await waitFor(() => expect(result.current.status).toBe("source-disconnected"))
    await act(async () => {
      await getDb().authConnections.put({
        id: "restored",
        status: "connected",
        identityKey: "identity",
      } as never)
    })
    await waitFor(() => expect(result.current).toEqual({ status: "available", canReopen: true }))
    act(dispose)
    await waitFor(() =>
      expect(result.current).toEqual({ status: "source-disconnected", canReopen: false })
    )
    await act(async () => {
      await getDb().remoteDocumentConnections.update(provenance.captureId, { sourceDeletedAt: 2 })
    })
    await waitFor(() =>
      expect(result.current).toEqual({ status: "source-deleted", canReopen: false })
    )
  } finally {
    dispose()
  }
})
