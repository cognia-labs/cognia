/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ list: (items: string[]) => items.join(" & ") }),
}))

import { renderHook } from "@testing-library/react"

import { usePythonReadinessText } from "./use-python-readiness-text"

describe("usePythonReadinessText", () => {
  const describe_ = () => renderHook(() => usePythonReadinessText()).result.current

  it("words every state from the Host's own details", () => {
    const text = describe_()
    expect(text({ state: "not-required" })).toBe("notRequired")
    expect(text({ state: "not-prepared", installer: "uv" })).toBe('notPrepared:{"installer":"uv"}')
    expect(text({ state: "preparing", installer: "pip" })).toBe('preparing:{"installer":"pip"}')
    expect(text({ state: "ready", scope: "shared", installer: "uv" })).toBe(
      'ready:{"scope":"shared","installer":"uv"}'
    )
    expect(text({ state: "failed", message: "pip exited 1", installer: "pip" })).toBe(
      'failed:{"message":"pip exited 1"}'
    )
  })

  it("lists every reason an environment is stale", () => {
    expect(
      describe_()({ state: "stale", reasons: ["dependencies", "interpreter"], installer: "uv" })
    ).toBe('stale:{"reasons":"staleReason.dependencies & staleReason.interpreter"}')
  })

  it("says why the Host does not manage an environment", () => {
    const text = describe_()
    expect(text({ state: "user-managed", reason: "venv-disabled" })).toBe(
      "userManaged.venvDisabled"
    )
    expect(text({ state: "user-managed", reason: "interpreter-override" })).toBe(
      "userManaged.interpreterOverride"
    )
    expect(text({ state: "user-managed", reason: "custom-installer" })).toBe(
      "userManaged.customInstaller"
    )
  })
})
