/** @jest-environment jsdom */
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({
  toast: {
    loading: jest.fn(() => "toast"),
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
  },
}))
jest.mock("@/lib/docs-providers", () => ({
  ...jest.requireActual("@/lib/docs-providers/types"),
  getDocsProvider: jest.fn(),
}))
jest.mock("@/lib/docs-providers/registry", () => ({
  getDocsProvider: jest.fn(),
  listDocsProviders: jest.fn(() => []),
  subscribeDocsProviders: jest.fn(() => jest.fn()),
}))
import { act, renderHook } from "@testing-library/react"
import { getDocsProvider } from "@/lib/docs-providers"
import { getDocsProvider as registryProvider } from "@/lib/docs-providers/registry"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { getDb } from "@/lib/db/schema"
import type { DocsProvider, RemoteDocRef } from "@/lib/docs-providers/types"
import { useRemoteDocStaging } from "./use-remote-doc-staging"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("resolves a legacy binding before fetching and captures the real connection locally", async () => {
  const account = { id: "connection-ref", label: "Person", authorizationEpoch: "3" }
  await getDb().authConnections.put({
    id: account.id,
    status: "connected",
    revision: 3,
    identityKey: "google-person",
  } as never)
  const fetch = jest.fn(async (ref: RemoteDocRef) => ({
    ref,
    title: "Report",
    text: "Body",
    format: "text" as const,
  }))
  const provider = {
    listAccounts: async () => [account],
    resolveLegacyAccount: jest.fn(async () => account),
    fetch,
  } as unknown as DocsProvider
  jest.mocked(getDocsProvider).mockReturnValue(provider)
  jest.mocked(registryProvider).mockReturnValue(provider)
  const acceptFiles = jest.fn(async (files: File[], _options?: unknown) => files)
  const { result } = renderHook(() => useRemoteDocStaging({ acceptFiles }))
  const doc = {
    providerId: "google",
    kind: "doc" as const,
    id: "document",
    title: "Report",
    accountBinding: { accountId: "default", authorizationEpoch: "old-native-nonce" },
  }
  await act(async () => {
    expect(
      await result.current({ providerId: "google", accountId: "default", doc })
    ).toBeInstanceOf(File)
  })
  expect(provider.resolveLegacyAccount).toHaveBeenCalledWith(
    { accountId: "default", authorizationEpoch: "old-native-nonce" },
    { credentialContext: { localAuthorization: LOCAL_PERSON_RUN } }
  )
  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({ accountBinding: { accountId: account.id, authorizationEpoch: "3" } }),
    expect.objectContaining({ accountId: account.id, expectedAuthorizationEpoch: "3" })
  )
  expect(await getDb().remoteDocumentConnections.toArray()).toEqual([
    expect.objectContaining({ connectionRef: account.id }),
  ])
  const options = acceptFiles.mock.calls[0][1] as { provenance: Map<File, unknown> }
  expect([...options.provenance.values()][0]).toMatchObject({ connectionScoped: true })
})

it("leaves an ambiguous legacy account unavailable without fetching or attaching", async () => {
  const fetch = jest.fn()
  const provider = {
    listAccounts: async () => [],
    resolveLegacyAccount: async () => null,
    fetch,
  } as unknown as DocsProvider
  jest.mocked(getDocsProvider).mockReturnValue(provider)
  const acceptFiles = jest.fn(async (files: File[], _options?: unknown) => files)
  const { result } = renderHook(() => useRemoteDocStaging({ acceptFiles }))
  await act(async () => {
    expect(
      await result.current({
        providerId: "google",
        accountId: "default",
        doc: {
          providerId: "google",
          kind: "doc",
          id: "document",
          title: "Report",
          accountBinding: { accountId: "default" },
        },
      })
    ).toBeNull()
  })
  expect(fetch).not.toHaveBeenCalled()
  expect(acceptFiles).not.toHaveBeenCalled()
})
