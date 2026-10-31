import { loggers } from "@cognia/logging"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { getAuthProviderOwner } from "./auth-provider-registry"
import {
  ConsumerTokenReadDenied,
  DEFAULT_CONSUMER_TOKEN_READ_POLICY,
  enforceConsumerTokenReadPolicy,
} from "./consumer-token-read-policy"

jest.mock("./auth-provider-registry", () => ({ getAuthProviderOwner: jest.fn() }))
jest.mock("@/lib/plugin/security/permission-guard", () => ({ getPermissionGuard: jest.fn() }))

it("pins the one-release transition", () => {
  expect(DEFAULT_CONSUMER_TOKEN_READ_POLICY).toBe("allow-with-audit")
})

it("audits every token read, warns once per consumer/provider, and contains no token", () => {
  jest.mocked(getAuthProviderOwner).mockReturnValue("owner")
  const recordUsage = jest.fn()
  jest.mocked(getPermissionGuard).mockReturnValue({ recordUsage } as never)
  const warn = jest.spyOn(loggers.plugin, "warn").mockImplementation(() => {})
  try {
    enforceConsumerTokenReadPolicy("consumer", "provider")
    enforceConsumerTokenReadPolicy("consumer", "provider")
    expect(recordUsage).toHaveBeenCalledTimes(2)
    expect(recordUsage).toHaveBeenLastCalledWith(
      "consumer",
      "auth:consume",
      "consumer-token-read provider:provider"
    )
    expect(warn).toHaveBeenCalledTimes(1)
    enforceConsumerTokenReadPolicy("consumer-2", "provider")
    enforceConsumerTokenReadPolicy("consumer", "provider-2")
    expect(warn).toHaveBeenCalledTimes(3)
  } finally {
    warn.mockRestore()
  }
})

it("leaves provider owners unaffected by either policy", () => {
  jest.mocked(getAuthProviderOwner).mockReturnValue("owner")
  const recordUsage = jest.fn()
  jest.mocked(getPermissionGuard).mockReturnValue({ recordUsage } as never)
  enforceConsumerTokenReadPolicy("owner", "provider", "allow-with-audit")
  enforceConsumerTokenReadPolicy("owner", "provider", "deny")
  expect(recordUsage).not.toHaveBeenCalled()
})

it.each([null, undefined, "another-owner"])(
  "denies non-owners including Host-owned providers (%s)",
  (owner) => {
    jest.mocked(getAuthProviderOwner).mockReturnValue(owner)
    expect(() => enforceConsumerTokenReadPolicy("consumer", "provider", "deny")).toThrow(
      ConsumerTokenReadDenied
    )
  }
)
