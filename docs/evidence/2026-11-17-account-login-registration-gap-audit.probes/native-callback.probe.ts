/** @jest-environment jsdom */
import { publishLogtoDeepLinkCallback } from "@/lib/logto/deep-link-callback"
import { platformSignInDrivers } from "@/lib/logto/platform-drivers"

const callback = (state: string) => ({
  kind: "logto_callback" as const,
  code: `code-${state}`,
  state,
  error: null,
  raw: `cn.cognia.app:/auth/callback?code=code-${state}&state=${state}`,
})

it("a legitimate stale native callback destroys the current real driver wait", async () => {
  const { drivers, redirectUri } = platformSignInDrivers({
    issuerKind: "oidc",
    profile: "desktop",
    isCapacitor: () => false,
  })
  const pending = drivers.waitForCode({ state: "flow-B", redirectUri })
  const rejected = expect(pending).rejects.toThrow("Logto callback state mismatch")
  publishLogtoDeepLinkCallback(callback("flow-A"))
  await rejected
  publishLogtoDeepLinkCallback(callback("flow-B"))
  await expect(pending).rejects.toThrow("Logto callback state mismatch")
})

it("a pre-aborted signal does not prevent a new real deep-link wait", async () => {
  const controller = new AbortController()
  const { drivers, redirectUri } = platformSignInDrivers({
    issuerKind: "oidc",
    profile: "desktop",
    isCapacitor: () => false,
    signal: controller.signal,
  })
  controller.abort()
  const pending = drivers.waitForCode({ state: "flow-A", redirectUri })
  publishLogtoDeepLinkCallback(callback("flow-A"))
  await expect(pending).resolves.toEqual({ code: "code-flow-A", state: "flow-A" })
})
