import {
  accountMatchesBinding,
  assertRemoteDocBinding,
  bindRemoteDocRef,
  resolveDocsAccountBinding,
} from "./account-binding"
import type { DocsProvider, RemoteDocRef } from "./types"

const ref: RemoteDocRef = { providerId: "test", kind: "doc", id: "same", title: "Spec" }

it("pins the original account and epoch without mutating the provider result", () => {
  const bound = bindRemoteDocRef(ref, { id: "a", label: "Same", authorizationEpoch: "first" })
  expect(bound.accountBinding).toEqual({ accountId: "a", authorizationEpoch: "first" })
  expect(ref.accountBinding).toBeUndefined()
  expect(() => assertRemoteDocBinding(bound, "b", "first")).toThrow("notAuthorized")
  expect(() => assertRemoteDocBinding(bound, "a", "second")).toThrow("notAuthorized")
  expect(() => bindRemoteDocRef(bound, { id: "b", label: "Same" })).toThrow("notAuthorized")
})

it("matches epochs exactly including missing legacy values", () => {
  expect(accountMatchesBinding({ id: "a", label: "A" }, { accountId: "a" })).toBe(true)
  expect(
    accountMatchesBinding({ id: "a", label: "A", authorizationEpoch: "new" }, { accountId: "a" })
  ).toBe(false)
  expect(accountMatchesBinding({ id: "b", label: "A" }, { accountId: "a" })).toBe(false)
})

it("delegates legacy ids to the provider and pins only an available account's current epoch", async () => {
  const account = { id: "actual-ref", label: "Person", authorizationEpoch: "3" }
  const hook = jest.fn(async () => account)
  const provider = {
    listAccounts: async () => [account],
    resolveLegacyAccount: hook,
  } as unknown as DocsProvider
  expect(
    await resolveDocsAccountBinding(provider, {
      accountId: "legacy",
      authorizationEpoch: "old-native-nonce",
    })
  ).toEqual({ accountId: "actual-ref", authorizationEpoch: "3" })
  expect(hook).toHaveBeenCalledWith({ accountId: "legacy", authorizationEpoch: "old-native-nonce" })
  hook.mockResolvedValue({ ...account, authorizationEpoch: "2" })
  expect(await resolveDocsAccountBinding(provider, { accountId: "legacy" })).toBeUndefined()
})

it("keeps providers without a legacy hook strict and avoids the hook for exact matches", async () => {
  const account = { id: "actual-ref", label: "Person", authorizationEpoch: "3" }
  const hook = jest.fn(async () => null)
  const provider = {
    listAccounts: async () => [account],
    resolveLegacyAccount: hook,
  } as unknown as DocsProvider
  expect(
    await resolveDocsAccountBinding(provider, { accountId: "actual-ref", authorizationEpoch: "3" })
  ).toEqual({ accountId: "actual-ref", authorizationEpoch: "3" })
  expect(hook).not.toHaveBeenCalled()
  expect(
    await resolveDocsAccountBinding(
      { ...provider, resolveLegacyAccount: undefined },
      { accountId: "actual-ref", authorizationEpoch: "2" }
    )
  ).toBeUndefined()
})
