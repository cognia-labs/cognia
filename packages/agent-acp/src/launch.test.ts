import { ACP_ENGINE_LAUNCH } from "./launch"
import { ACP_VENDOR_PROFILES } from "./vendor-profiles"

it("collects every vendor profile's descriptor and the plain ACP engines", () => {
  const ids = ACP_ENGINE_LAUNCH.map((descriptor) => descriptor.id)
  for (const profile of ACP_VENDOR_PROFILES) {
    if (profile.launch) expect(ids).toContain(profile.launch.id)
  }
  expect(ids).toEqual(expect.arrayContaining(["gemini", "qwen", "kiro", "factory-droid", "cursor"]))
  expect(new Set(ids).size).toBe(ids.length)
})

it("keeps the Devin and Antigravity engines without a private state root", () => {
  const byId = new Map(ACP_ENGINE_LAUNCH.map((descriptor) => [descriptor.id, descriptor]))
  expect(byId.get("devin")?.isolation).toBeUndefined()
  expect(byId.get("antigravity-acp")?.isolation).toBeUndefined()
  expect(byId.get("qwen")?.isolation?.env).toEqual({
    QWEN_HOME: "qwen",
    QWEN_RUNTIME_DIR: "qwen-runtime",
  })
})
