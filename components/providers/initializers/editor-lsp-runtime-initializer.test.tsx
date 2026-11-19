/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"

import { isTauri } from "@/lib/tauri"
import { ensureEditorLspRuntime } from "@/lib/lsp/ensure-editor-lsp-runtime"
import { EditorLspRuntimeInitializer } from "./editor-lsp-runtime-initializer"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/lsp/ensure-editor-lsp-runtime", () => ({
  ensureEditorLspRuntime: jest.fn(),
}))
let mockRemoteHost: object | null = null
let mockRemoteNotify: (() => void) | undefined
jest.mock("@/lib/lsp/host-transport", () => ({
  getRemoteLspTransport: jest.fn(() => mockRemoteHost),
  subscribeRemoteLspTransport: jest.fn((listener: () => void) => {
    mockRemoteNotify = listener
    return () => {
      if (mockRemoteNotify === listener) mockRemoteNotify = undefined
    }
  }),
}))

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockEnsure = ensureEditorLspRuntime as jest.MockedFunction<typeof ensureEditorLspRuntime>

describe("EditorLspRuntimeInitializer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRemoteHost = null
    mockRemoteNotify = undefined
  })

  it("ensures the runtime once on the desktop host", () => {
    mockIsTauri.mockReturnValue(true)
    render(<EditorLspRuntimeInitializer />)
    expect(mockEnsure).toHaveBeenCalledTimes(1)
  })

  it("does nothing off the desktop host", () => {
    mockIsTauri.mockReturnValue(false)
    render(<EditorLspRuntimeInitializer />)
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it("starts against a remote host and re-runs when the active route changes", () => {
    mockIsTauri.mockReturnValue(false)
    render(<EditorLspRuntimeInitializer />)
    expect(mockEnsure).not.toHaveBeenCalled()

    act(() => {
      mockRemoteHost = {}
      mockRemoteNotify?.()
    })
    expect(mockEnsure).toHaveBeenCalledTimes(1)
    act(() => {
      mockRemoteHost = {}
      mockRemoteNotify?.()
    })
    expect(mockEnsure).toHaveBeenCalledTimes(2)
  })

  it("does not re-trigger across a rerender", () => {
    mockIsTauri.mockReturnValue(true)
    const { rerender } = render(<EditorLspRuntimeInitializer />)
    rerender(<EditorLspRuntimeInitializer />)
    expect(mockEnsure).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    mockIsTauri.mockReturnValue(true)
    const { container } = render(<EditorLspRuntimeInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
