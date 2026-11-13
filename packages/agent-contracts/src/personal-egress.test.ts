import { personalEgressToolDenied } from "./personal-egress"

it.each([
  "Bash",
  "bash",
  "shell_execute_advanced",
  "start_process",
  "terminal_dock_spawn",
  "WebFetch",
  "web_fetch",
  "mcp__foreign__read",
  "mcp__foreign__web_search",
  "new_network_tool",
])("denies opaque %s only on a fenced run", (name) => {
  expect(personalEgressToolDenied(name, true)).toBe(true)
  expect(personalEgressToolDenied(name, false)).toBe(false)
})

it("keeps only native search and Host-proven read ports available", () => {
  expect(
    personalEgressToolDenied("WebSearch", true, [], {
      kind: "native",
      registeredTools: ["WebSearch"],
    })
  ).toBe(false)
  expect(
    personalEgressToolDenied("mcp__cognia-plugin-tools__web_search", true, [], { kind: "host" })
  ).toBe(false)
  expect(
    personalEgressToolDenied("Read", true, [], { kind: "native", registeredTools: ["Read"] })
  ).toBe(false)
  expect(personalEgressToolDenied("mcp__host__read", true, ["mcp__host__read"])).toBe(false)
})

it.each(["Read", "WebSearch", "Glob"])(
  "G1: native exemption requires registered ownership for %s",
  (name) => {
    expect(personalEgressToolDenied(name, true)).toBe(true)
    expect(
      personalEgressToolDenied(name, true, [name], { kind: "plugin", pluginId: "p", toolId: name })
    ).toBe(true)
    expect(
      personalEgressToolDenied(name, true, [], { kind: "native", registeredTools: [name] })
    ).toBe(false)
  }
)

it.each([
  "Bash",
  "WebFetch",
  "mcp__third__read",
  "sandbox_bash",
  "browser_open",
  "plugin_network_fetch",
  "network_fetch",
  "cli_bash",
  "external_engine",
  "openPane",
])("G2: verified-empty %s passes independent of ownership", (name) => {
  expect(
    personalEgressToolDenied(name, false, [], { kind: "plugin", pluginId: "third", toolId: name })
  ).toBe(false)
})
