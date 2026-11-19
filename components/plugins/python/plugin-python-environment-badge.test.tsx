/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ list: (items: string[]) => items.join(", ") }),
}))
const mockGetReadiness = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ getPythonReadiness: (id: string) => mockGetReadiness(id) }),
}))
const mockRequestPrompt = jest.fn()
jest.mock("@/lib/plugin/python/prepare-prompt-requests", () => ({
  requestPythonPreparePrompt: (id: string) => mockRequestPrompt(id),
}))

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { PythonReadiness } from "@/lib/plugin/python/readiness"
import {
  __resetPythonReadinessStoreForTesting,
  recordPythonReadiness,
} from "@/stores/plugin-runtime/python-readiness-store"

import { PluginPythonEnvironmentBadge } from "./plugin-python-environment-badge"

const plugin = { id: "wiki", manifest: { type: "python", pythonDependencies: ["requests"] } }

function answer(readiness: PythonReadiness) {
  act(() => recordPythonReadiness("wiki", { readiness, interpreterWarning: null }))
}

beforeEach(() => {
  __resetPythonReadinessStoreForTesting()
  mockGetReadiness.mockReset().mockResolvedValue(null)
  mockRequestPrompt.mockReset()
})

describe("PluginPythonEnvironmentBadge", () => {
  it("shows nothing for a plugin without a Python side", async () => {
    const { container } = render(
      <PluginPythonEnvironmentBadge plugin={{ id: "ui", manifest: { type: "frontend" } }} />
    )
    await act(async () => undefined)
    expect(container).toBeEmptyDOMElement()
    expect(mockGetReadiness).not.toHaveBeenCalled()
  })

  it("shows nothing until the Host answered", async () => {
    const { container } = render(<PluginPythonEnvironmentBadge plugin={plugin} />)
    await act(async () => undefined)
    expect(mockGetReadiness).toHaveBeenCalledWith("wiki")
    expect(container).toBeEmptyDOMElement()
  })

  it("says it is ready to run when the environment matches, or none is needed", async () => {
    render(<PluginPythonEnvironmentBadge plugin={plugin} />)
    answer({ state: "ready", scope: "isolated", installer: "uv" })
    const badge = screen.getByTestId("plugin-python-environment-wiki")
    expect(badge).toHaveAttribute("data-python-environment", "runnable")
    expect(badge).toHaveTextContent("badge.runnable")
    answer({ state: "not-required" })
    expect(badge).toHaveAttribute("data-python-environment", "runnable")
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("offers to prepare dependencies that are not ready, through the consent prompt", async () => {
    const user = userEvent.setup()
    render(<PluginPythonEnvironmentBadge plugin={plugin} />)
    answer({ state: "stale", reasons: ["dependencies"], installer: "uv" })
    const badge = screen.getByTestId("plugin-python-environment-wiki")
    expect(badge).toHaveAttribute("data-python-environment", "not-ready")
    expect(badge).toHaveTextContent("badge.notReady")
    expect(screen.getByText("badge.notReady")).toHaveAttribute(
      "title",
      'stale:{"reasons":"staleReason.dependencies"}'
    )
    await user.click(screen.getByRole("button", { name: "prepare" }))
    expect(mockRequestPrompt).toHaveBeenCalledWith("wiki")
  })

  it("shows a running preparation without offering another", () => {
    render(<PluginPythonEnvironmentBadge plugin={plugin} />)
    answer({ state: "preparing", installer: "pip" })
    expect(screen.getByTestId("plugin-python-environment-wiki")).toHaveTextContent(
      "badge.preparing"
    )
    expect(screen.queryByRole("button", { name: "prepare" })).not.toBeInTheDocument()
  })

  it("says installed when the user manages the environment", () => {
    render(<PluginPythonEnvironmentBadge plugin={plugin} />)
    answer({ state: "user-managed", reason: "interpreter-override" })
    const badge = screen.getByTestId("plugin-python-environment-wiki")
    expect(badge).toHaveAttribute("data-python-environment", "installed")
    expect(screen.getByText("badge.installed")).toHaveAttribute(
      "title",
      "userManaged.interpreterOverride"
    )
  })
})
