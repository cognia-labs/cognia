import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2018",
  external: ["zod"],
  // Source-only primitives must ship as compiled code, not a node_modules TS import.
  noExternal: ["@cognia/primitives"],
})
