import { createLocalKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { applyProxyPasswordMutation, NETWORK_PROXY_PASSWORD_KEY } from "./proxy-credentials"

jest.mock("@/lib/credentials/keyring-store", () => ({
  createLocalKeyringStore: jest.fn(),
}))

const mockedCreateStore = jest.mocked(createLocalKeyringStore)
let values: Map<string, string>
let store: jest.Mocked<KeyringStore>

beforeEach(() => {
  values = new Map()
  store = {
    save: jest.fn(async (key, value) => {
      values.set(key, value)
    }),
    load: jest.fn(async (key) => values.get(key) ?? null),
    delete: jest.fn(async (key) => {
      values.delete(key)
    }),
    isPersistent: jest.fn(() => true),
  }
  mockedCreateStore.mockReturnValue(store)
})

it("implements keep, replace, and explicit clear mutations", async () => {
  values.set(NETWORK_PROXY_PASSWORD_KEY, "old")
  await expect(applyProxyPasswordMutation({ kind: "keep" })).resolves.toBe(true)
  await expect(applyProxyPasswordMutation({ kind: "replace", value: "new" })).resolves.toBe(true)
  expect(values.get(NETWORK_PROXY_PASSWORD_KEY)).toBe("new")
  await expect(applyProxyPasswordMutation({ kind: "clear" })).resolves.toBe(false)
  expect(values.has(NETWORK_PROXY_PASSWORD_KEY)).toBe(false)
})
