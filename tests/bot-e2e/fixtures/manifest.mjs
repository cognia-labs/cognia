export function fixtureManifest() {
  const manifest = {
    id: "bot-e2e",
    name: "Bot E2E workload",
    version: "1.0.0",
    description: "Isolated process-level Bot acceptance workload",
    author: "Cognia",
    engines: { cognia: ">=0.1.0" },
    minAppVersion: "0.1.0",
    type: "frontend",
    main: "plugin.mjs",
    capabilities: ["bot", "integrations"],
    permissions: [
      "agent:control",
      "integrations:read",
      "integrations:manage",
      "integrations:events",
    ],
    integrations: [
      {
        id: "fixture",
        label: "E2E accounts",
        authStrategies: [],
        resourceKinds: ["probe"],
        eventTypes: [{ id: "ping", label: "Probe", resourceKinds: ["probe"] }],
        actions: [],
      },
    ],
    runtimeCompatibility: {
      headless: { availability: "supported", entrypoint: "plugin.mjs" },
    },
    bots: [
      {
        id: "handler",
        name: "E2E handler",
        version: "1.0.0",
        executor: "handler",
        entry: "plugin.mjs",
        export: "handler",
        triggers: [
          { id: "first", kind: "manual", concurrencyKey: "serial" },
          { id: "second", kind: "manual", concurrencyKey: "serial" },
          { id: "event-a", kind: "event", source: "bot", types: ["bot-e2e.ping"] },
          { id: "event-b", kind: "event", source: "bot", types: ["bot-e2e.ping"] },
        ],
        policy: {
          maxConcurrentRuns: 1,
          maxRunDurationMs: 180_000,
          allowSelfTriggering: false,
        },
        configSchema: {
          type: "object",
          required: ["recorder"],
          additionalProperties: false,
          properties: { recorder: { type: "string", pattern: "^http://127\\.0\\.0\\.1:" } },
        },
      },
    ],
  }
  manifest.bots.push({
    ...manifest.bots[0],
    id: "bound",
    name: "E2E bound input",
    requires: {
      credentials: [
        { id: "a", label: "A", integration: "fixture" },
        { id: "b", label: "B", integration: "fixture" },
      ],
    },
    triggers: [
      {
        id: "input",
        kind: "event",
        source: "integration",
        types: ["ping"],
        inputCredentialSlot: "a",
      },
    ],
  })
  return manifest
}
