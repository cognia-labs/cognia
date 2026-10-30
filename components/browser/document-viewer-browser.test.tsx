/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  DocumentViewerBrowser,
  DOCUMENT_VIEWER_LOGIN_HOSTS,
  isDocumentLoginUrl,
  isDocumentProviderHost,
} from "./document-viewer-browser"
import {
  documentViewerStore,
  ensureDocumentViewerPage,
  signOutDocumentViewer,
  answerDocumentViewerDialog,
  DocumentViewerError,
  subscribeDocumentViewerFrames,
  activateDocumentViewerPage,
  type DocumentViewerPage,
} from "@/lib/browser/document-viewer-session"
import { localBrowser } from "@/lib/browser/local-client"
import { recordBrowserVisit } from "@/lib/db/browser-history"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/db/browser-history", () => ({ recordBrowserVisit: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => undefined) }))
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: { rpc: jest.fn(async () => undefined) },
}))
jest.mock("@/lib/browser/document-viewer-session", () => ({
  ...jest.requireActual("@/lib/browser/document-viewer-session"),
  ensureDocumentViewerPage: jest.fn(),
  activateDocumentViewerPage: jest.fn(async () => undefined),
  retainDocumentViewer: jest.fn(() => () => undefined),
  subscribeDocumentViewerFrames: jest.fn(() => () => undefined),
  refreshDocumentViewerPages: jest.fn(async () => undefined),
  signOutDocumentViewer: jest.fn(async () => undefined),
  answerDocumentViewerDialog: jest.fn(async () => undefined),
}))
const url = "https://docs.google.com/document/d/abcdefghijklmnop/edit"
const page: DocumentViewerPage = { id: "p", url, title: "Document", active: true, loading: true }
function updatePage(patch: Partial<DocumentViewerPage>) {
  act(() =>
    documentViewerStore.setState((state) => ({
      byTab: { d: { ...(state.byTab.d ?? page), ...patch } },
    }))
  )
}
function mount(providerId = "google", original = url) {
  const onState = jest.fn()
  const result = render(
    <DocumentViewerBrowser
      sessionId="chat"
      docTabId="d"
      url={original}
      providerId={providerId}
      onState={onState}
    />
  )
  return { ...result, onState }
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(isTauri).mockReturnValue(true)
  documentViewerStore.setState({
    sessionId: null,
    status: "idle",
    error: null,
    byTab: {},
    pages: [],
    dialogs: {},
    activePageId: null,
  })
  jest.mocked(ensureDocumentViewerPage).mockImplementation(async () => {
    await Promise.resolve()
    documentViewerStore.setState({
      sessionId: "viewer",
      status: "ready",
      byTab: { d: page },
      activePageId: page.id,
    })
    return page
  })
})
it("reports preparing, loading, login, loading, then ready only after a first-party document finishes", async () => {
  const { onState } = mount()
  expect(onState).toHaveBeenCalledWith("preparing", undefined)
  await waitFor(() => expect(onState).toHaveBeenCalledWith("loading", undefined))
  updatePage({ url: "https://accounts.google.com/signin", loading: true })
  expect(onState).toHaveBeenLastCalledWith("needs-login", undefined)
  updatePage({ url, loading: true })
  expect(onState).toHaveBeenLastCalledWith("loading", undefined)
  updatePage({ loading: false })
  expect(onState).toHaveBeenLastCalledWith("ready", undefined)
  updatePage({ url: "https://sso.example.com/document/d/abcdefghijklmnop/edit", loading: false })
  expect(onState).toHaveBeenLastCalledWith("loading", undefined)
  expect(recordBrowserVisit).not.toHaveBeenCalled()
})
it("only badges first-party document hosts and never embeds a webview/iframe", async () => {
  const { container } = mount()
  await screen.findByRole("application", { name: "live.canvas" })
  await waitFor(() => expect(screen.getByText("live.providerBadge")).toBeInTheDocument())
  expect(screen.getByText("docs.google.com")).toBeInTheDocument()
  updatePage({ url: "https://docs.google.com.evil.example/" })
  expect(screen.queryByText("live.providerBadge")).toBeNull()
  expect(container.querySelector("iframe, webview")).toBeNull()
  expect(recordBrowserVisit).not.toHaveBeenCalled()
})
it("runs navigation and external open against the displayed isolated page", async () => {
  mount()
  await waitFor(() => expect(screen.getByRole("button", { name: "live.reload" })).toBeEnabled())
  for (const [label, op] of [
    ["live.back", "browser.back"],
    ["live.forward", "browser.forward"],
    ["live.reload", "browser.reload"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: label }))
    expect(localBrowser.rpc).toHaveBeenCalledWith(op, { sessionId: "viewer", pageId: "p" })
  }
  fireEvent.click(screen.getByRole("button", { name: "openSystem" }))
  expect(openExternal).toHaveBeenCalledWith(url)
})
it("follows the document's visible popup for frames, input, navigation and dialogs", async () => {
  mount()
  await waitFor(() => expect(screen.getByRole("button", { name: "live.reload" })).toBeEnabled())
  updatePage({ id: "popup", openerId: "p", url: "https://accounts.google.com/signin" })
  await waitFor(() =>
    expect(subscribeDocumentViewerFrames).toHaveBeenLastCalledWith(
      "popup",
      expect.any(Function),
      expect.any(Function)
    )
  )
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application"), { key: "a", code: "KeyA" })
  })
  expect(localBrowser.rpc).toHaveBeenCalledWith(
    "browser.input",
    expect.objectContaining({
      sessionId: "viewer",
      pageId: "popup",
    })
  )
  fireEvent.click(screen.getByRole("button", { name: "live.reload" }))
  expect(localBrowser.rpc).toHaveBeenCalledWith("browser.reload", {
    sessionId: "viewer",
    pageId: "popup",
  })
  act(() =>
    documentViewerStore.setState({
      dialogs: { popup: { type: "alert", message: "Popup question" } },
    })
  )
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Popup question")
  await userEvent.setup().click(screen.getByRole("button", { name: "accept" }))
  expect(answerDocumentViewerDialog).toHaveBeenCalledWith("popup", { accept: true })
})

it("does not send input or resize work to an unfinished page reservation", async () => {
  mount()
  await waitFor(() => expect(screen.getByRole("button", { name: "live.reload" })).toBeEnabled())
  updatePage({ id: "pending:d" })
  jest.mocked(localBrowser.rpc).mockClear()
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application"), { key: "a", code: "KeyA" })
    fireEvent.pointerDown(screen.getByRole("application"), { button: 0 })
  })
  expect(localBrowser.rpc).not.toHaveBeenCalled()
  expect(subscribeDocumentViewerFrames).not.toHaveBeenCalledWith(
    "pending:d",
    expect.anything(),
    expect.anything()
  )
})

it("resizes the visible document to the surface and follows density changes", async () => {
  let width = 420
  const widthSpy = jest
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockImplementation(() => width)
  const heightSpy = jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700)
  let measure!: ResizeObserverCallback
  const disconnect = jest.fn()
  const observer = jest.spyOn(globalThis, "ResizeObserver").mockImplementation((callback) => {
    measure = callback
    return { observe: jest.fn(), unobserve: jest.fn(), disconnect }
  })
  let densityChanged!: EventListener
  const remove = jest.fn()
  const media = jest.spyOn(window, "matchMedia").mockImplementation((query) => ({
    media: query,
    matches: false,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    removeEventListener: remove,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      densityChanged = listener as EventListener
    },
  }))
  const density = window.devicePixelRatio
  const { unmount } = mount()
  try {
    await waitFor(() =>
      expect(localBrowser.rpc).toHaveBeenCalledWith("browser.emulate", {
        sessionId: "viewer",
        pageId: "p",
        viewport: { width: 420, height: 700, deviceScaleFactor: density, fitToWidth: false },
        synchronizeFrame: true,
      })
    )
    width = 620
    act(() => measure([], {} as ResizeObserver))
    await waitFor(() =>
      expect(localBrowser.rpc).toHaveBeenLastCalledWith("browser.emulate", {
        sessionId: "viewer",
        pageId: "p",
        viewport: { width: 620, height: 700, deviceScaleFactor: density, fitToWidth: false },
      })
    )
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
    act(() => densityChanged(new Event("change")))
    await waitFor(() =>
      expect(localBrowser.rpc).toHaveBeenLastCalledWith("browser.emulate", {
        sessionId: "viewer",
        pageId: "p",
        viewport: { width: 620, height: 700, deviceScaleFactor: 2, fitToWidth: false },
      })
    )
    expect(media).toHaveBeenLastCalledWith("(resolution: 2dppx)")
  } finally {
    unmount()
    expect(disconnect).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith("change", densityChanged)
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: density })
    widthSpy.mockRestore()
    heightSpy.mockRestore()
    observer.mockRestore()
    media.mockRestore()
  }
})

it("waits for background-page activation before requesting a synchronized viewport", async () => {
  const width = jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(420)
  const height = jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700)
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  jest.mocked(ensureDocumentViewerPage).mockImplementationOnce(async () => {
    documentViewerStore.setState({ sessionId: "viewer", byTab: { d: page }, activePageId: "other" })
    return page
  })
  jest.mocked(activateDocumentViewerPage).mockImplementationOnce(async (pageId) => {
    await gate
    documentViewerStore.setState({ activePageId: pageId })
  })
  const { unmount } = mount()
  try {
    await waitFor(() => expect(activateDocumentViewerPage).toHaveBeenCalledWith("p"))
    expect(localBrowser.rpc).not.toHaveBeenCalledWith("browser.emulate", expect.anything())
    await act(async () => {
      finish()
    })
    await waitFor(() =>
      expect(localBrowser.rpc).toHaveBeenCalledWith("browser.emulate", {
        sessionId: "viewer",
        pageId: "p",
        synchronizeFrame: true,
        viewport: {
          width: 420,
          height: 700,
          deviceScaleFactor: window.devicePixelRatio,
          fitToWidth: false,
        },
      })
    )
  } finally {
    unmount()
    width.mockRestore()
    height.mockRestore()
  }
})
it("requires confirmation before signing out the separate browser login", async () => {
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByRole("button", { name: "live.more" }))
  await user.click(screen.getByRole("menuitem", { name: "live.signOut" }))
  expect(screen.getByRole("alertdialog")).toHaveTextContent("live.signOutDescription")
  expect(signOutDocumentViewer).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "live.cancel" }))
  expect(signOutDocumentViewer).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "live.more" }))
  await user.click(screen.getByRole("menuitem", { name: "live.signOut" }))
  await user.click(screen.getByRole("button", { name: "live.signOut" }))
  expect(signOutDocumentViewer).toHaveBeenCalledTimes(1)
})
it.each(["alert", "confirm", "prompt", "beforeunload"])(
  "answers the page's %s dialog",
  async (type) => {
    const user = userEvent.setup()
    mount()
    await waitFor(() => expect(ensureDocumentViewerPage).toHaveBeenCalled())
    act(() =>
      documentViewerStore.setState({
        dialogs: { p: { type, message: "Page question", defaultValue: "Draft" } },
      })
    )
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Page question")
    await user.click(screen.getByRole("button", { name: "accept" }))
    expect(answerDocumentViewerDialog).toHaveBeenCalledWith(
      "p",
      type === "prompt" ? { accept: true, promptText: "Draft" } : { accept: true }
    )
  }
)
it.each([
  ["chromium_not_installed: missing", "blocked", "chromium"],
  ["browser_profile_in_use: busy", "blocked", "profile-in-use"],
  ["browser_document_viewer_op_refused: denied", "blocked", "op-refused"],
  ["browser_session_option_invalid: purpose", "blocked", "update-app"],
  ["runtime_exited: gone", "error", "runtime-exited"],
])("reports %s without a fallback browser", async (error, state, reason) => {
  jest.mocked(ensureDocumentViewerPage).mockRejectedValueOnce(new Error(error))
  const { onState } = mount()
  await waitFor(() => expect(onState).toHaveBeenLastCalledWith(state, { reason }))
})
it("does not create a session on web", () => {
  jest.mocked(isTauri).mockReturnValue(false)
  const { onState } = mount()
  expect(onState).toHaveBeenLastCalledWith("blocked", { reason: "web" })
  expect(ensureDocumentViewerPage).not.toHaveBeenCalled()
})
it("reports the typed page cap refusal so the dock can ask to close another tab", async () => {
  jest
    .mocked(ensureDocumentViewerPage)
    .mockRejectedValueOnce(new DocumentViewerError("cap-reached"))
  const { onState } = mount()
  await waitFor(() =>
    expect(onState).toHaveBeenLastCalledWith("blocked", { reason: "cap-reached" })
  )
})
it("recognizes Feishu login and returns to ready only on a finished document", async () => {
  const original = "https://tenant.feishu.cn/docx/abcdefghijklmnop"
  const { onState } = mount("lark", original)
  await waitFor(() => expect(ensureDocumentViewerPage).toHaveBeenCalled())
  updatePage({ url: "https://passport.feishu.cn/login", loading: false })
  expect(onState).toHaveBeenLastCalledWith("needs-login", undefined)
  updatePage({ url: original, loading: false })
  expect(onState).toHaveBeenLastCalledWith("ready", undefined)
})
it("uses one tested login host list with strict suffix boundaries", () => {
  for (const [provider, hosts] of Object.entries(DOCUMENT_VIEWER_LOGIN_HOSTS)) {
    for (const host of hosts) {
      expect(isDocumentLoginUrl(`https://${host}/signin`, provider)).toBe(true)
      expect(isDocumentLoginUrl(`https://${host}.evil.test/`, provider)).toBe(false)
      expect(isDocumentLoginUrl(`http://${host}/`, provider)).toBe(false)
      expect(isDocumentLoginUrl(`https://user@${host}/`, provider)).toBe(false)
    }
  }
  expect(isDocumentLoginUrl(url, "google")).toBe(false)
  expect(isDocumentProviderHost(url, "lark")).toBe(false)
  expect(
    isDocumentProviderHost("https://tenant.larkoffice.com/docx/abcdefghijklmnop", "lark")
  ).toBe(true)
  expect(isDocumentProviderHost("https://feishu.cn.evil.test/docx/abcdefghijklmnop", "lark")).toBe(
    false
  )
  expect(isDocumentProviderHost("https://evilfeishu.cn/docx/abcdefghijklmnop", "lark")).toBe(false)
  expect(isDocumentProviderHost("https://docs.google.com:8443/", "google")).toBe(false)
  expect(
    isDocumentProviderHost("https://@docs.google.com/document/d/abcdefghijklmnop/edit", "google")
  ).toBe(false)
})
