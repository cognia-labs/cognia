import { defineConfig } from "tsup"

// provider-types is pure type/constant definitions. Once the real source is
// moved in (Stage 1) it has zero `@/` imports. Inline the dependency-free brand
// catalog so compiled metadata stays portable; zod validators remain external.
export default defineConfig({
  // Build every module (not just the barrel) so subpath imports
  // (`@cognia/provider-types/circuit-breaker`, …) resolve from dist too and the
  // whole package is validated as standalone-compilable.
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2017",
  external: ["zod", /^@cognia\/provider-/],
  noExternal: ["@cognia/brand-assets"],
})
