import {
  __setCompanionConfigCacheForTests,
  CompanionTransport,
} from "@/lib/tauri/transport-companion"
import { setTransport, transport } from "@/lib/tauri/transport-instance"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import {
  configureRpcDispatcher,
  resetRegistry,
  subscribeToVscodeEvents,
} from "@/lib/plugin/vscode-shim/rpc-dispatcher"
import {
  authorizeRemoteLspHost,
  LSP_TAURI_CHANNEL_ID,
  TauriLspClientAdapter,
} from "@/lib/plugin/lsp/lsp-client-adapter-tauri"
import { DEVICE_LSP_EVENT, getRemoteLspTransport, listenToLspHostEvents } from "./host-transport"

jest.mock("@/lib/plugin/core/vscode-loader", () => ({
  isVscodeHostAvailable: () => false,
  invokeVscodeRpc: jest.fn(),
}))

jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: jest.fn(async () => ({
    token: "fixture-lease",
    expiresAt: Date.now() + 30_000,
  })),
}))

const initialTransport = transport

function pairBrowser(deviceId: string) {
  __setCompanionConfigCacheForTests({
    deviceId,
    baseUrl: "https://fixture.invalid",
    serverVersion: "fixture",
  })
  const companion = new CompanionTransport()
  const callbacks: Array<(payload: unknown) => void> = []
  const unsubscribe = jest.fn()
  const subscribe = jest.spyOn(companion, "subscribe").mockImplementation((event, callback) => {
    expect(event).toBe(DEVICE_LSP_EVENT)
    callbacks.push(callback as (payload: unknown) => void)
    return unsubscribe
  })
  const ready = jest.spyOn(companion, "whenSubscribed").mockResolvedValue()
  const accepted = jest.spyOn(companion, "hasSubscribedChannels").mockReturnValue(true)
  const call = jest.spyOn(companion, "call").mockResolvedValue('{"accepted":true}')
  setTransport(companion)
  return {
    companion,
    call,
    subscribe,
    unsubscribe,
    ready,
    accepted,
    emit(method: string, params: object) {
      const rawFrame = JSON.stringify({ jsonrpc: "2.0", method, params })
      for (const callback of callbacks)
        callback({ tenantId: "fixture-tenant", generation: "system", rawFrame })
    },
  }
}

afterEach(() => {
  configureRpcDispatcher(null)
  resetRegistry()
  __setCompanionConfigCacheForTests(null)
  setTransport(initialTransport)
})

it("routes diagnostics and a callback over direct browser pairing and fences the previous host", async () => {
  expect(getActiveRemoteTransport()).toBeNull()
  const first = pairBrowser("browser-a")
  expect(getRemoteLspTransport()).toBe(first.companion)
  configureRpcDispatcher({
    listen: async (event, receive) =>
      listenToLspHostEvents(event, (payload) => receive({ payload })),
    sendResponse: jest.fn(),
  })
  await subscribeToVscodeEvents(LSP_TAURI_CHANNEL_ID)
  const adapter = new TauriLspClientAdapter()
  const owner = { ownerId: "user", serverId: "fixture" }
  const diagnostics = jest.fn()
  const folders = [{ uri: "file:///fixture", name: "fixture" }]
  const updatedFolders = [{ uri: "file:///updated", name: "updated" }]
  const start = () =>
    adapter.start({
      ...owner,
      config: { id: "fixture", name: "Fixture", languages: ["typescript"], command: "fixture" },
      onDiagnostics: diagnostics,
      workspaceFolders: folders,
    })
  await expect(start()).rejects.toThrow("interactive_approval_required")
  expect(first.call).not.toHaveBeenCalled()
  await authorizeRemoteLspHost()
  first.accepted.mockReturnValueOnce(false)
  await expect(start()).rejects.toThrow("remote LSP event subscription unavailable")
  expect(first.call).not.toHaveBeenCalled()
  await start()
  expect(first.ready).toHaveBeenCalledWith([DEVICE_LSP_EVENT])
  expect(first.ready.mock.invocationCallOrder[0]).toBeLessThan(
    first.call.mock.invocationCallOrder[0]
  )
  const startPayload = first.call.mock.calls[0][1]?.payloadJson
  expect(JSON.parse(String(startPayload)).forwardServerRequests).toEqual([
    "workspace/workspaceFolders",
  ])
  await adapter.clientNotification({
    ...owner,
    method: "workspace/didChangeWorkspaceFolders",
    payload: { event: { added: updatedFolders, removed: folders } },
  })
  first.emit("lsp:publishDiagnostics", { ...owner, uri: "file:///fixture/a.ts", diagnostics: [] })
  first.emit("lsp:serverRequest", {
    ...owner,
    method: "workspace/workspaceFolders",
    requestId: "a",
  })
  expect(diagnostics).toHaveBeenCalledWith("file:///fixture/a.ts", [])
  expect(first.call).toHaveBeenLastCalledWith("lsp_host_request", {
    method: "lsp:serverResponse",
    payloadJson: JSON.stringify({ ...owner, requestId: "a", result: updatedFolders }),
    adminLease: "fixture-lease",
  })

  const second = pairBrowser("browser-b")
  expect(first.unsubscribe).toHaveBeenCalledTimes(1)
  expect(second.subscribe).toHaveBeenCalledTimes(1)
  first.emit("lsp:publishDiagnostics", {
    ...owner,
    uri: "file:///fixture/stale.ts",
    diagnostics: [],
  })
  expect(diagnostics).toHaveBeenCalledTimes(1)
  await expect(start()).rejects.toThrow("interactive_approval_required")
  expect(second.call).not.toHaveBeenCalled()
  await authorizeRemoteLspHost()
  await start()
  second.emit("lsp:publishDiagnostics", { ...owner, uri: "file:///fixture/b.ts", diagnostics: [] })
  expect(diagnostics).toHaveBeenLastCalledWith("file:///fixture/b.ts", [])

  const callback = jest.fn()
  await adapter.start({
    ...owner,
    config: { id: "fixture", name: "Fixture", languages: ["typescript"], command: "fixture" },
    onDiagnostics: diagnostics,
    onServerRequest: callback,
  })
  second.emit("lsp:serverRequest", {
    ...owner,
    method: "workspace/workspaceFolders",
    requestId: "pending-b",
  })
  expect(callback).toHaveBeenCalledTimes(1)
  const third = pairBrowser("browser-c")
  await authorizeRemoteLspHost()
  await expect(
    adapter.serverResponse({ ...owner, requestId: "pending-b", result: folders })
  ).resolves.toBe(false)
  expect(third.call).not.toHaveBeenCalled()
})
