/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ list: (items: string[]) => items.join(" & ") }),
}))
const mockToast = { loading: jest.fn(() => "toast-1"), success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    loading: (...args: unknown[]) => mockToast.loading(...(args as [])),
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}))
const mockGetReadiness = jest.fn()
const mockInstallDeps = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    getPythonReadiness: (...args: unknown[]) => mockGetReadiness(...args),
    installPythonDeps: (...args: unknown[]) => mockInstallDeps(...args),
  }),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  __resetPythonPreparePromptsForTests,
  requestPythonPreparePrompt,
  subscribePythonPreparePrompts,
  type PythonPreparePromptState,
} from "@/lib/plugin/python/prepare-prompt-requests"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import {
  __resetPythonReadinessStoreForTesting,
  recordPythonPreparation,
  recordPythonReadiness,
} from "@/stores/plugin-runtime/python-readiness-store"

import {
  PYTHON_PREPARE_PROMPT_ROW_WAIT_MS,
  PythonPreparePromptHost,
} from "./python-prepare-prompt-host"

function seed(plugins: Record<string, { type: string; pythonDependencies?: string[] }>) {
  usePluginStore.setState((state) => ({
    ...state,
    plugins: Object.fromEntries(
      Object.entries(plugins).map(([id, manifest]) => [
        id,
        { manifest: { id, name: id, version: "1.0.0", ...manifest } },
      ])
    ) as never,
  }))
}

const notPrepared = {
  readiness: { state: "not-prepared", installer: "uv" },
  lock: null,
  interpreterWarning: null,
}

let prompts: PythonPreparePromptState = { current: null, queue: [] }
let unsubscribe = () => undefined as void

beforeEach(() => {
  __resetPythonPreparePromptsForTests()
  unsubscribe = subscribePythonPreparePrompts((state) => {
    prompts = state
  })
  seed({})
  __resetPythonReadinessStoreForTesting()
  mockGetReadiness.mockReset().mockResolvedValue(notPrepared)
  mockInstallDeps.mockReset().mockResolvedValue(null)
  mockToast.loading.mockClear()
  mockToast.success.mockClear()
  mockToast.error.mockClear()
})

afterEach(() => {
  unsubscribe()
  jest.useRealTimers()
})

function ask(pluginId: string) {
  act(() => requestPythonPreparePrompt(pluginId))
}

describe("PythonPreparePromptHost", () => {
  it("asks to prepare a just-installed plugin whose environment is not prepared", async () => {
    seed({ wiki: { type: "python", pythonDependencies: ["requests>=2"] } })
    render(<PythonPreparePromptHost />)
    ask("wiki")
    expect(await screen.findByTestId("python-prepare-dialog")).toBeInTheDocument()
    expect(mockGetReadiness).toHaveBeenCalledWith("wiki")
    expect(screen.getByTestId("python-prepare-dependencies")).toHaveTextContent("requests>=2")
    expect(screen.getByText(/"installer":"uv"/)).toBeInTheDocument()
  })

  it("prepares in the background after consent and reports how it went", async () => {
    seed({ wiki: { type: "hybrid", pythonDependencies: ["requests>=2"] } })
    const user = userEvent.setup()
    render(<PythonPreparePromptHost />)
    ask("wiki")
    await user.click(await screen.findByRole("button", { name: "confirm" }))
    await waitFor(() =>
      expect(mockInstallDeps).toHaveBeenCalledWith("wiki", ["requests>=2"], { installUv: false })
    )
    expect(mockToast.loading).toHaveBeenCalledWith('toast.preparing:{"name":"wiki"}')
    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('toast.ready:{"name":"wiki"}', {
        id: "toast-1",
      })
    )
    expect(prompts.current).toBeNull()
  })

  it("says the plugin runs again when the manager restarted it", async () => {
    seed({ wiki: { type: "python", pythonDependencies: ["requests>=2"] } })
    mockInstallDeps.mockImplementation(async (id: string) => {
      recordPythonPreparation(id, { status: "succeeded", outcome: null, resumed: true })
      return null
    })
    const user = userEvent.setup()
    render(<PythonPreparePromptHost />)
    ask("wiki")
    await user.click(await screen.findByRole("button", { name: "confirm" }))
    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('toast.resumed:{"name":"wiki"}', {
        id: "toast-1",
      })
    )
  })

  it("reports a failed preparation on the same toast", async () => {
    seed({ wiki: { type: "python", pythonDependencies: ["requests>=2"] } })
    mockInstallDeps.mockRejectedValue(new Error("no network"))
    const user = userEvent.setup()
    render(<PythonPreparePromptHost />)
    ask("wiki")
    await user.click(await screen.findByRole("button", { name: "confirm" }))
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('toast.failed:{"name":"wiki"}', {
        id: "toast-1",
        description: "no network",
      })
    )
  })

  it("asks for a locked plugin that declares no requirements, naming what its lock pins", async () => {
    seed({ wiki: { type: "python" } })
    mockGetReadiness.mockResolvedValue({
      readiness: { state: "not-prepared", installer: "uv" },
      lock: { packages: ["six==1.16.0"], offline: true, ignoresManifestDependencies: false },
      interpreterWarning: null,
    })
    const user = userEvent.setup()
    render(<PythonPreparePromptHost />)
    ask("wiki")
    expect(await screen.findByTestId("python-prepare-dependencies")).toHaveTextContent(
      "six==1.16.0"
    )
    expect(screen.getByText(/bodyLocked:.*"offline":"true"/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "confirm" }))
    await waitFor(() =>
      expect(mockInstallDeps).toHaveBeenCalledWith("wiki", [], { installUv: false })
    )
  })

  it("installs uv first when the plugin is locked and uv is missing", async () => {
    seed({ wiki: { type: "python" } })
    mockGetReadiness.mockResolvedValue({
      readiness: { state: "needs-uv", installer: "uv" },
      lock: { packages: ["six==1.16.0"], offline: false, ignoresManifestDependencies: false },
      interpreterWarning: null,
    })
    const user = userEvent.setup()
    render(<PythonPreparePromptHost />)
    ask("wiki")
    expect(await screen.findByTestId("python-prepare-needs-uv")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "confirmWithUv" }))
    await waitFor(() =>
      expect(mockInstallDeps).toHaveBeenCalledWith("wiki", [], { installUv: true })
    )
  })

  it("words a failure from the cause the Host named", async () => {
    seed({ wiki: { type: "python" } })
    mockGetReadiness.mockResolvedValue({
      readiness: { state: "not-prepared", installer: "uv" },
      lock: { packages: [], offline: false, ignoresManifestDependencies: false },
      interpreterWarning: null,
    })
    mockInstallDeps.mockImplementation(async (id: string) => {
      recordPythonReadiness(id, {
        readiness: {
          state: "failed",
          message: "python host: uv.lock does not match pyproject.toml",
          cause: { kind: "lock-out-of-date" },
          installer: "uv",
        },
        lock: null,
        interpreterWarning: null,
      })
      throw new Error("python host: uv.lock does not match pyproject.toml")
    })
    const user = userEvent.setup()
    render(<PythonPreparePromptHost />)
    ask("wiki")
    await user.click(await screen.findByRole("button", { name: "confirm" }))
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('toast.failed:{"name":"wiki"}', {
        id: "toast-1",
        description: "failedCause.lockOutOfDate",
      })
    )
  })

  it("puts it off on later and moves on to the next plugin", async () => {
    seed({
      a: { type: "python", pythonDependencies: ["x"] },
      b: { type: "python", pythonDependencies: ["y"] },
    })
    const user = userEvent.setup()
    render(<PythonPreparePromptHost />)
    ask("a")
    ask("b")
    expect(await screen.findByTestId("python-prepare-dependencies")).toHaveTextContent("x")
    await user.click(screen.getByRole("button", { name: "later" }))
    await waitFor(() =>
      expect(screen.getByTestId("python-prepare-dependencies")).toHaveTextContent("y")
    )
    expect(mockInstallDeps).not.toHaveBeenCalled()
  })

  it.each([
    ["a frontend plugin", { type: "frontend", pythonDependencies: ["x"] }, notPrepared],
    [
      "a Python plugin the Host says needs nothing",
      { type: "python", pythonDependencies: [] },
      { readiness: { state: "not-required" }, lock: null, interpreterWarning: null },
    ],
    [
      "a ready environment",
      { type: "python", pythonDependencies: ["x"] },
      {
        readiness: { state: "ready", scope: "shared", installer: "uv" },
        lock: null,
        interpreterWarning: null,
      },
    ],
    [
      "a preparation already running",
      { type: "python", pythonDependencies: ["x"] },
      { readiness: { state: "preparing", installer: "uv" }, lock: null, interpreterWarning: null },
    ],
    [
      "an environment the user manages",
      { type: "python", pythonDependencies: ["x"] },
      {
        readiness: { state: "user-managed", reason: "venv-disabled" },
        lock: null,
        interpreterWarning: null,
      },
    ],
    ["no answer the build can read", { type: "python", pythonDependencies: ["x"] }, null],
  ])("asks nothing for %s", async (_label, manifest, report) => {
    seed({ p: manifest })
    mockGetReadiness.mockResolvedValue(report)
    render(<PythonPreparePromptHost />)
    ask("p")
    await waitFor(() => expect(prompts.current).toBeNull())
    expect(screen.queryByTestId("python-prepare-dialog")).not.toBeInTheDocument()
  })

  it("waits for an installed plugin's row to reach the store", async () => {
    render(<PythonPreparePromptHost />)
    ask("late")
    await act(async () => undefined)
    expect(mockGetReadiness).not.toHaveBeenCalled()
    act(() => seed({ late: { type: "python", pythonDependencies: ["x"] } }))
    expect(await screen.findByTestId("python-prepare-dialog")).toBeInTheDocument()
  })

  it("gives up on a row that never arrives", async () => {
    jest.useFakeTimers()
    render(<PythonPreparePromptHost />)
    ask("ghost")
    await act(async () => {
      jest.advanceTimersByTime(PYTHON_PREPARE_PROMPT_ROW_WAIT_MS)
    })
    expect(prompts.current).toBeNull()
    expect(mockGetReadiness).not.toHaveBeenCalled()
  })
})
