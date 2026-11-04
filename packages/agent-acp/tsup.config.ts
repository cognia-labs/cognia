import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: [
      "src/**/*.ts",
      "!src/**/*.test.ts",
      "!src/hermes-acp-bridge.ts",
      "!src/hermes-gateway-probe.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: "neutral",
    target: "es2022",
    external: [/^@cognia\//],
  },
  {
    entry: ["src/hermes-acp-bridge.ts", "src/hermes-gateway-probe.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    platform: "node",
    target: "node26",
    external: [/^@cognia\//],
  },
])
