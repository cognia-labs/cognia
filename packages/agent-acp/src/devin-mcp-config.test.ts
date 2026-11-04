import {
  assertDevinMcpTarget,
  parseDevinJsonc,
  devinInjectedServers,
  devinIsolatedPrimaryConfig,
  projectDevinMcpConfig,
} from "./devin-mcp-config"

it("preserves comment-like strings and trailing commas in Devin JSONC", () => {
  expect(parseDevinJsonc('{/* comment */ "url":"https://host/a,}", "list":[1,],}')).toEqual({
    url: "https://host/a,}",
    list: [1],
  })
  expect(() => parseDevinJsonc("{/* unterminated")).toThrow("Invalid Devin MCP configuration")
})
it("projects only the original organization and setup state for isolated bots", () => {
  expect(
    devinIsolatedPrimaryConfig({
      version: 2,
      devin: { org_id: "org", token: "private" },
      mcpServers: { ambient: {} },
    })
  ).toEqual({ version: 2, devin: { org_id: "org" }, shell: { setup_complete: true } })
})
it("merges session servers with native precedence and confines bot projections", () => {
  const primary = { mcpServers: { native: { command: "native" } } }
  const dedicated = { mcpServers: { dedicated: { command: "dedicated" } } }
  const injected = devinInjectedServers(
    JSON.stringify([{ name: "session", command: "node", args: [], env: [] }])
  )
  expect(
    projectDevinMcpConfig(primary, dedicated, injected, "/config", false).dedicated.mcpServers
  ).toMatchObject({
    native: { env: { XDG_CONFIG_HOME: "/config" } },
    dedicated: { command: "dedicated" },
    session: { command: "node" },
  })
  expect(
    Object.keys(
      projectDevinMcpConfig(primary, dedicated, injected, "/config", true).dedicated.mcpServers
    )
  ).toEqual(["session"])
})
it("rejects duplicate headers and payload/target changes before Host IO", () => {
  expect(() =>
    devinInjectedServers(
      JSON.stringify([
        {
          name: "x",
          type: "http",
          url: "https://local",
          headers: [
            { name: "A", value: "1" },
            { name: "A", value: "2" },
          ],
        },
      ])
    )
  ).toThrow()
  expect(() => assertDevinMcpTarget("other", ["acp"])).toThrow()
  expect(() => assertDevinMcpTarget("devin", ["run"])).toThrow()
  expect(() => assertDevinMcpTarget("DEVIN.EXE", ["acp"])).not.toThrow()
})
