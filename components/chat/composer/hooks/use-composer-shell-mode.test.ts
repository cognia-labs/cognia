/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { ComposerTrigger } from "../../composer-trigger"

import { useComposerShellMode, type ComposerShellModeInput } from "./use-composer-shell-mode"

let intelligence: Record<string, unknown> = {}
const useShellIntelligence = jest.fn((..._args: unknown[]) => intelligence)
jest.mock("@/hooks/chat/use-shell-intelligence", () => ({
  useShellIntelligence: (...args: unknown[]) => useShellIntelligence(...args),
}))

const tShellUi = ((key: string, values?: Record<string, string>) =>
  values
    ? `${key}:${JSON.stringify(values)}`
    : key) as unknown as ComposerShellModeInput["tShellUi"]
const bash = { kind: "bash" } as ComposerTrigger

function render(input: Partial<ComposerShellModeInput>) {
  return renderHook(() =>
    useComposerShellMode({
      textValue: "",
      caret: 0,
      cwd: "/repo",
      trigger: null,
      tShellUi,
      ...input,
    })
  ).result.current
}

beforeEach(() => {
  jest.clearAllMocks()
  intelligence = {
    enabled: true,
    availability: "full",
    query: "gre",
    diagnostics: [],
    markSubmitted: jest.fn(),
    dismiss: jest.fn(),
  }
})

it("hands the intelligence the first line without its `!` and a cursor on that line", () => {
  render({ textValue: "!git sta\nsecond", caret: 9, trigger: bash })

  expect(useShellIntelligence).toHaveBeenCalledWith(
    expect.objectContaining({ line: "git sta", cursor: 7, cwd: "/repo" })
  )
})

it("sends no line outside `!` mode", () => {
  render({ textValue: "hello", caret: 3 })
  expect(useShellIntelligence).toHaveBeenCalledWith(
    expect.objectContaining({ line: null, cursor: 0 })
  )
})

it("shifts diagnostics by the `!` so they land on the textarea", () => {
  intelligence.diagnostics = [{ from: 0, to: 3, message: "x" }]
  const result = render({ textValue: "!foo", caret: 4, trigger: bash })
  expect(result.shellDiagnosticsForOverlay).toEqual([{ from: 1, to: 4, message: "x" }])
  expect(result.markShellSubmitted).toBe(intelligence.markSubmitted)
  expect(result.dismissShell).toBe(intelligence.dismiss)
})

it("says why the panel is empty: off, no Host, or no match for the token", () => {
  intelligence.enabled = false
  expect(render({ trigger: bash }).shellEmptyMessage).toBe("")

  intelligence.enabled = true
  intelligence.availability = "static-only"
  expect(render({ trigger: bash }).shellEmptyMessage).toBe("shell.noHost")

  intelligence.availability = "full"
  expect(render({ trigger: bash }).shellEmptyMessage).toBe('shell.noMatches:{"query":"gre"}')
})
