import {
  generateRolloutBucket,
  normalizeRolloutBucket,
  ROLLOUT_BUCKET_COUNT,
} from "./update-cohort"

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")

afterEach(() => {
  if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor)
  else Reflect.deleteProperty(globalThis, "crypto")
})

describe("update cohort", () => {
  it("reduces crypto randomness to the shared 10,000-bucket range", () => {
    const fallback = jest.fn(() => 0.5)
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: (values: Uint32Array) => {
          values[0] = 0xffffffff
          return values
        },
      },
    })
    expect(ROLLOUT_BUCKET_COUNT).toBe(10_000)
    expect(generateRolloutBucket(fallback)).toBe(0xffffffff % ROLLOUT_BUCKET_COUNT)
    expect(fallback).not.toHaveBeenCalled()
  })

  it("uses the supplied random source when crypto is unavailable", () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined })
    expect(generateRolloutBucket(() => 0)).toBe(0)
    expect(generateRolloutBucket(() => 0.99999)).toBe(9999)
  })

  it.each([0, 4321, 9999])("preserves valid persisted bucket %s", (bucket) => {
    const random = jest.fn(() => 0.5)
    expect(normalizeRolloutBucket(bucket, random)).toBe(bucket)
    expect(random).not.toHaveBeenCalled()
  })

  it.each([undefined, null, "4321", -1, 10_000, 1.5, NaN, Infinity])(
    "regenerates invalid persisted bucket %s",
    (bucket) => {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined })
      expect(normalizeRolloutBucket(bucket, () => 0.4321)).toBe(4321)
    }
  )
})
