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

  it("words a locked plugin's states (ENV02)", () => {
    const text = describe_()
    expect(text({ state: "needs-uv", installer: "uv" })).toBe("needsUv")
    expect(text({ state: "stale", reasons: ["lock"], installer: "uv" })).toBe(
      'stale:{"reasons":"staleReason.lock"}'
    )
    expect(
      text({
        state: "failed",
        message: "uv sync failed",
        cause: { kind: "lock-out-of-date" },
        installer: "uv",
      })
    ).toBe("failedCause.lockOutOfDate")
    expect(
      text({
        state: "failed",
        message: "uv sync failed",
        cause: { kind: "missing-wheels", packages: ["six==1.16.0", "idna==3.10"] },
        installer: "uv",
      })
    ).toBe('failedCause.missingWheels:{"packages":"six==1.16.0 & idna==3.10"}')
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
