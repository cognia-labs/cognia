import {
  executeConnectorManagement,
  listConnectorManagementOperations,
  validateConnectorManagementRequest,
} from "./management"
import type { PlatformAdapter } from "@/types/connectors/adapter"

function adapter() {
  const execute = jest.fn(async () => ({ status: "ok" as const }))
  const instance = {
    id: "any-platform",
    meta: { type: "matrix", capabilities: ["assets.manage", "menus.manage"] },
    health: () => ({ state: "running" }),
    management: { operations: ["assets.upload", "assets.list", "menus.set"], execute },
  } as unknown as PlatformAdapter
  return { instance, execute }
}
describe("shared add-contact links", () => {
  function linkedAdapter() {
    const { instance, execute } = adapter()
    instance.meta.capabilities = ["links.create"] as never
    instance.management!.operations = ["links.create"] as never
    execute.mockResolvedValue({
      status: "ok",
      link: { purpose: "add-contact", url: "https://example.org/invite?state=launch" },
    } as never)
    return { instance, execute }
  }
  const request = {
    operation: "links.create",
    input: { purpose: "add-contact", state: "launch" },
  } as const
  it("discovers and serves the contract on a non-QQ adapter", async () => {
    const { instance, execute } = linkedAdapter()
    expect(listConnectorManagementOperations(instance)).toEqual([
      { operation: "links.create", capability: "links.create", mutation: "destructive" },
    ])
    await expect(executeConnectorManagement(instance, request as never)).resolves.toMatchObject({
      link: { purpose: "add-contact", url: "https://example.org/invite?state=launch" },
    })
    expect(execute).toHaveBeenCalledWith(request)
  })
  it("checks capability, running state, private data and wire-field injection before execution", async () => {
    const { instance, execute } = linkedAdapter()
    instance.meta.capabilities = []
    await expect(executeConnectorManagement(instance, request as never)).rejects.toThrow(
      /unsupported/
    )
    instance.meta.capabilities = ["links.create"] as never
    instance.health = () => ({ state: "down" })
    await expect(executeConnectorManagement(instance, request as never)).rejects.toThrow(/running/)
    instance.health = () => ({ state: "running" })
    for (const input of [
      { purpose: "add-contact", state: "private@example.com" },
      { purpose: "add-contact", state: "x\nsecret" },
      { purpose: "add-contact", state: "x".repeat(257) },
      { purpose: "add-contact", callback_data: "bypass" },
      { purpose: "custom", url: "https://example.org" },
    ])
      await expect(
        executeConnectorManagement(instance, { operation: "links.create", input } as never)
      ).rejects.toThrow(/PII|parameters/)
    expect(execute).not.toHaveBeenCalled()
  })
  it.each([
    undefined,
    { purpose: "other", url: "https://example.org" },
    { purpose: "add-contact", url: "javascript:alert(1)" },
    { purpose: "add-contact", url: "http://example.org" },
    { purpose: "add-contact", url: "https://u:p@example.org" },
    { purpose: "add-contact", url: "https://127.0.0.1/invite" },
    { purpose: "add-contact", url: "https://example.org/\nsecret" },
    { purpose: "add-contact", url: `https://example.org/${"x".repeat(8192)}` },
  ])("rejects an invalid adapter link receipt: %j", async (link) => {
    const { instance, execute } = linkedAdapter()
    execute.mockResolvedValue({ status: "ok", link } as never)
    await expect(executeConnectorManagement(instance, request as never)).rejects.toThrow(/link/i)
  })
})
it("scans published command links before adapter execution", () => {
  expect(() =>
    validateConnectorManagementRequest({
      operation: "commands.create",
      input: {
        panel: {
          scope: "group",
          audience: "all",
          name: "Commands",
          items: [
            {
              name: "Contact",
              description: "Link",
              url: "https://example.org/?email=private@example.com",
            },
          ],
        },
      },
    })
  ).toThrow(/PII/)
})
it("rejects cyclic menus before recursive schema traversal", () => {
  const item = { key: "cycle", label: "Loop", children: [] as unknown[] }
  item.children.push(item)
  expect(() =>
    validateConnectorManagementRequest({
      operation: "menus.set",
      input: { items: [item] },
    } as never)
  ).toThrow(/depth limit/)
})
it("discovers and executes the same contract on another platform", async () => {
  const { instance, execute } = adapter()
  expect(listConnectorManagementOperations(instance)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operation: "assets.list", mutation: "read" }),
    ])
  )
  expect(
    await executeConnectorManagement(instance, { operation: "assets.list", input: {} })
  ).toEqual({ status: "ok" })
  expect(execute).toHaveBeenCalledWith({ operation: "assets.list", input: {} })
})
it("refuses absent capabilities and malformed or private sources before side effects", async () => {
  const { instance, execute } = adapter()
  await expect(
    executeConnectorManagement(instance, {
      operation: "members.remove",
      input: { chatId: "chat", memberIds: ["member"] },
    })
  ).rejects.toThrow(/unsupported/)
  for (const url of ["file:///etc/passwd", "http://127.0.0.1/a", "https://user:pass@example.org/a"])
    await expect(
      executeConnectorManagement(instance, {
        operation: "assets.upload",
        input: { name: "image.png", mimeType: "image/png", source: { url } },
      })
    ).rejects.toThrow(/public/)
  await expect(
    executeConnectorManagement(instance, {
      operation: "assets.upload",
      input: { name: "image.png", mimeType: "image/png", source: { dataBase64: "invalid" } },
    })
  ).rejects.toThrow(/base64/)
  expect(execute).not.toHaveBeenCalled()
})
it("rejects unexpected native fields and outbound identifying text", async () => {
  const { instance, execute } = adapter()
  await expect(
    executeConnectorManagement(instance, {
      operation: "assets.list",
      input: { uploadUrl: "https://evil.example" },
    } as never)
  ).rejects.toThrow(/parameters/)
  await expect(
    executeConnectorManagement(instance, {
      operation: "menus.set",
      input: {
        items: [
          { key: "key", label: "private@example.com", action: { type: "prompt", value: "Help" } },
        ],
      },
    })
  ).rejects.toThrow(/PII/)
  expect(execute).not.toHaveBeenCalled()
})
