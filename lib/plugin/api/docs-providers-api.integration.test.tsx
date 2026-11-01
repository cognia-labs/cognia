/** @jest-environment jsdom */
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import {
  defineDocsProvider,
  type PluginContext,
  type PluginManifest,
  type PluginDocsProvidersAPI,
} from "@cognia/plugin-sdk"
import { createDocsProvidersAPI, clearDocsProvidersForPlugin } from "./docs-providers-api"
import { unregisterDocsProvidersForPlugin } from "@/lib/plugin/bridge/docs-providers-bridge"
import { ComposerAttachMenu } from "@/components/chat/composer/attach-menu"
import { DocsProvidersCard } from "@/components/settings/connections/docs-providers/docs-providers-card"
import { DocumentSnapshotView } from "@/components/artifacts/dock-document/document-snapshot-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useRemoteDocSearch } from "@/hooks/chat/use-remote-doc-search"
import { useRemoteDocStaging } from "@/hooks/chat/use-remote-doc-staging"
import { getDocsProvider } from "@/lib/docs-providers/registry"
import { classifyCloudDocumentUrl } from "@/lib/docs-providers/document-url"
import type { RemoteDocumentProvenanceV1 } from "@/lib/docs-providers/document-provenance"
import { openAttachedDocument } from "@/lib/artifacts/open-chat-document"
import {
  subscribeDockDocumentLifecycle,
  useDockDocumentCache,
} from "@/lib/artifacts/dock-documents"
import { useDockDocumentsStore } from "@/stores/artifact/dock-documents-store"
import { useChatStore } from "@/stores/chat"
import messages from "@/i18n/messages/en.json"

jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "web" }))
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => "web-standalone" }))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => "web",
}))
jest.mock("@/lib/plugin/auth/connections-api", () => ({ createAuthConnectionsAPI: jest.fn() }))
jest.mock("sonner", () => ({
  toast: {
    loading: jest.fn(() => "pending"),
    dismiss: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}))
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ add: jest.fn(), files: [] }),
}))
jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/chat/message-parts/file-part-preview", () => ({
  FilePartPreview: ({ filename }: { filename: string }) => (
    <div role="document" aria-label={filename} />
  ),
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => undefined }))
jest.mock("@/lib/docs-providers/providers/lark", () => ({
  larkDocsProvider: {
    id: "lark",
    mentionPrefix: "lark:",
    kinds: ["doc"],
    hosts: ["tauri"],
    listAccounts: async () => [],
    matchRef: () => null,
    fetch: jest.fn(),
  },
}))
jest.mock("@/lib/docs-providers/providers/google", () => ({
  googleDocsProvider: {
    id: "google",
    mentionPrefix: "gdoc:",
    kinds: ["doc"],
    hosts: ["tauri"],
    listAccounts: async () => [],
    matchRef: () => null,
    fetch: jest.fn(),
  },
}))
jest.mock("@/lib/docs-providers/providers/google/config", () => ({
  GOOGLE_DOCS_SCOPES: [],
  getGoogleDocsSettings: async () => ({}),
  subscribeGoogleDocsSettings: () => () => {},
  saveGoogleClientSecret: jest.fn(),
  updateGoogleDocsSettings: jest.fn(),
}))
jest.mock("@/lib/docs-providers/providers/google/auth", () => ({
  beginGoogleDocsAuth: jest.fn(),
  disconnectGoogleDocs: jest.fn(),
}))

const definition = {
  id: "docs",
  label: "Acme Documents",
  mentionPrefix: "acceptance.docs:",
  kinds: ["doc" as const],
  urlOrigins: ["https://docs.example.test"],
}
const manifest: PluginManifest = {
  id: "acceptance",
  name: "Acme",
  description: "Test document provider",
  version: "1.0.0",
  type: "frontend",
  main: "index.js",
  capabilities: ["docs-provider"],
  permissions: ["docs:provide", "auth:consume", "integrations:execute"],
  docsProviders: [definition],
}
const url = "https://docs.example.test/report"
const connection: Awaited<ReturnType<PluginContext["auth"]["connections"]["list"]>>[number] = {
  ref: "host-connection" as AuthConnectionRef,
  providerId: "acme-auth",
  accountLabel: "Alice",
  principalKind: "user",
  issuer: "https://docs.example.test",
  scopes: ["docs.read"],
  status: "connected",
  revision: 7,
}

/** This fake plugin uses only the public SDK context and helper, without Host imports. */
function activateFakePlugin(ctx: {
  docsProviders: PluginDocsProvidersAPI
  auth: { connections: Pick<PluginContext["auth"]["connections"], "list"> }
  integrations: Pick<PluginContext["integrations"], "listAccounts" | "authenticatedRequest">
}) {
  return ctx.docsProviders.register(
    defineDocsProvider({
      id: "docs",
      mentionPrefix: "acceptance.docs:",
      kinds: ["doc"],
      async listAccounts() {
        return (await ctx.auth.connections.list({ providerId: "acme-auth" })).map((account) => ({
          id: account.ref,
          label: account.accountLabel,
          authorizationEpoch: String(account.revision),
        }))
      },
      matchRef(input) {
        const address = new URL(input)
        return address.pathname === "/report"
          ? { kind: "doc", id: "report", url: `${address.origin}/report` }
          : null
      },
      async fetch(ref, options) {
        const integration = (await ctx.integrations.listAccounts("acme-docs")).find(
          (account) => account.connectionId === options.accountId
        )
        if (!integration) throw new Error("Connection unavailable")
        const response = await ctx.integrations.authenticatedRequest<{ text: string }>(
          integration.id,
          ref.url!,
          { signal: options.signal }
        )
        return { ref, title: "Acme Report", text: response.data.text, format: "markdown" }
      },
    })
  )
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>{children}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

const originalCreateUrl = URL.createObjectURL
const originalRevokeUrl = URL.revokeObjectURL
beforeAll(() => {
  URL.createObjectURL = jest.fn(() => "blob:docs-acceptance")
  URL.revokeObjectURL = jest.fn()
})
afterAll(() => {
  URL.createObjectURL = originalCreateUrl
  URL.revokeObjectURL = originalRevokeUrl
})
afterEach(() => {
  clearDocsProvidersForPlugin(manifest.id)
  subscribeDockDocumentLifecycle()()
})

it("takes one fake public plugin from picker/settings through staging and dock reopen to disable/unavailable", async () => {
  useChatStore.setState({
    sessions: { s: { id: "s", status: "idle" } } as never,
    activeSessionId: "s",
  })
  useDockDocumentsStore.setState({ bySession: {} })
  useDockDocumentCache.setState({ byId: {} })
  const listConnections = jest.fn(async () => [connection])
  const connections = { list: listConnections, onDidChange: () => () => {} }
  const transport = jest.fn(
    async (_accountId: string, _target: string, _init?: { signal?: AbortSignal }) => ({
      status: 200,
      headers: {},
      data: { text: "User-kept report body" },
    })
  )
  const docsProviders = createDocsProvidersAPI(manifest.id, manifest, {
    connections,
    hasPermission: () => true,
  })
  const integration = {
    id: "integration-account",
    pluginId: manifest.id,
    integrationId: "acme-docs",
    providerId: "acme-auth",
    authSessionId: connection.ref,
    connectionId: connection.ref,
    remoteAccountId: "alice",
    label: "Alice",
    enabled: true,
    health: "healthy" as const,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  }
  const registration = activateFakePlugin({
    docsProviders,
    auth: { connections },
    integrations: {
      listAccounts: async () => [integration],
      authenticatedRequest: transport as PluginContext["integrations"]["authenticatedRequest"],
    },
  })
  const provider = getDocsProvider(registration.providerId)!
  expect(provider.hosts).toEqual(["web"])
  expect(provider.matchRef("https://other.example.test/report")).toBeNull()
  expect(classifyCloudDocumentUrl(url)?.providerId).toBe("plugin:acceptance/docs")

  const insert = jest.fn()
  render(
    <>
      <DocsProvidersCard />
      <ComposerAttachMenu onPickFiles={jest.fn()} onInsert={insert} />
    </>,
    { wrapper }
  )
  fireEvent.click(screen.getByRole("button", { name: "Cloud document" }))
  fireEvent.click(screen.getByRole("button", { name: "Acme Documents" }))
  expect(insert).toHaveBeenCalledWith("@acceptance.docs:")
  await waitFor(() => expect(screen.getByText("Acme Documents")).toBeInTheDocument())
  expect(await screen.findByText("Alice")).toBeInTheDocument()

  const search = renderHook(
    () => useRemoteDocSearch({ namespace: definition.mentionPrefix, query: url }),
    { wrapper }
  )
  await waitFor(() => expect(search.result.current.accountId).toBe(connection.ref))
  const selected = search.result.current.items[0]
  expect(selected.accountBinding).toEqual({ accountId: connection.ref, authorizationEpoch: "7" })
  let provenance!: RemoteDocumentProvenanceV1
  const acceptFiles = jest.fn(
    async (
      files: File[],
      options: Parameters<Parameters<typeof useRemoteDocStaging>[0]["acceptFiles"]>[1]
    ) => {
      expect(options.isCurrent()).toBe(true)
      expect(await options.beforeCommit()).toBe(true)
      provenance = options.provenance.get(files[0])!
      return files
    }
  )
  const staging = renderHook(() => useRemoteDocStaging({ acceptFiles }), { wrapper })
  let file!: File | null
  await act(async () => {
    file = await staging.result.current({
      providerId: provider.id,
      accountId: connection.ref,
      doc: selected,
    })
  })
  expect(file?.name).toBe("Acme Report.md")
  expect(transport).toHaveBeenCalledWith("integration-account", url, {
    signal: expect.any(AbortSignal),
  })
  expect(provenance).toMatchObject({
    v: 1,
    providerId: "plugin:acceptance/docs",
    resourceId: "report",
    url,
  })
  expect(provenance).not.toHaveProperty("connectionRef")
  const body = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(file!)
  })
  act(() => {
    expect(
      openAttachedDocument({
        provenance,
        sessionId: "s",
        text: body,
        mediaType: file!.type,
        origin: "staged",
      })
    ).toBe(true)
  })
  const tab = useDockDocumentsStore.getState().bySession.s.documents[0]
  expect(tab.providerId).toBe(provider.id)
  render(<DocumentSnapshotView sessionId="s" tab={tab} />, { wrapper })
  await waitFor(() =>
    expect(screen.getByRole("document", { name: "Acme Report.md" })).toBeInTheDocument()
  )

  act(() => {
    unregisterDocsProvidersForPlugin(manifest.id)
  })
  expect(getDocsProvider(provider.id)).toBeUndefined()
  expect(screen.queryByText("Acme Documents")).toBeNull()
  expect(screen.getByRole("alert")).toHaveTextContent("The document provider is not configured.")
  expect(screen.getByRole("document", { name: "Acme Report.md" })).toBeInTheDocument()
  expect(search.result.current.provider).toBeNull()
  expect(acceptFiles).toHaveBeenCalledTimes(1)
})
