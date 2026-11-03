import { defineConfig } from "tsup"

// Inline the private privacy implementation so the staged sidecar needs no
// transitive workspace symlink. Browser consumers still use the TS source.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  noExternal: ["@cognia/redact"],
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
})
