/** @jest-environment node */
import { DEFAULT_POLICY, readPolicy, writePolicy } from "./plugins-policy-storage"

test("Headless policy retains an explicit per-plugin trust grant without a window", () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const marker = Object.getOwnPropertyDescriptor(globalThis, "__COGNIA_HEADLESS__")
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, "__COGNIA_HEADLESS__", { configurable: true, value: true })
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  try {
    expect(typeof window).toBe("undefined")
    const policy = { ...DEFAULT_POLICY, trustedFrontendPlugins: ["bot-e2e"] }
    writePolicy(policy)
    expect(readPolicy()).toEqual(policy)
  } finally {
    if (storage) Object.defineProperty(globalThis, "localStorage", storage)
    else Reflect.deleteProperty(globalThis, "localStorage")
    if (marker) Object.defineProperty(globalThis, "__COGNIA_HEADLESS__", marker)
    else Reflect.deleteProperty(globalThis, "__COGNIA_HEADLESS__")
  }
})

test.each([true, false])("uninitialized Node storage is never read (headless=%s)", (headless) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const marker = Object.getOwnPropertyDescriptor(globalThis, "__COGNIA_HEADLESS__")
  const getter = jest.fn(() => {
    throw new Error("unconfigured Node storage")
  })
  Object.defineProperty(globalThis, "__COGNIA_HEADLESS__", { configurable: true, value: headless })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: getter })
  try {
    expect(readPolicy()).toEqual(DEFAULT_POLICY)
    expect(() => writePolicy(DEFAULT_POLICY)).not.toThrow()
    expect(getter).not.toHaveBeenCalled()
  } finally {
    if (storage) Object.defineProperty(globalThis, "localStorage", storage)
    else Reflect.deleteProperty(globalThis, "localStorage")
    if (marker) Object.defineProperty(globalThis, "__COGNIA_HEADLESS__", marker)
    else Reflect.deleteProperty(globalThis, "__COGNIA_HEADLESS__")
  }
})
