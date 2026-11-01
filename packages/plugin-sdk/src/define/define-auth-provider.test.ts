import { defineAuthProvider } from "./define-auth-provider"
import { __makeSession } from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import type { PluginAuthProvider } from "../api/auth-provider"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"

describe("defineAuthProvider", () => {
  it("returns the provider unchanged (pure pass-through)", () => {
    const session = __makeSession({
      accessToken: "t",
      account: { id: "u", label: "U" },
      scopes: [],
    })
    const input: PluginAuthProvider = {
      id: "acme",
      label: "Acme",
      getSessions: async () => [session],
      createSession: async () => session,
      removeSession: async () => {},
    }
    const provider = defineAuthProvider(input)
    expect(provider).toBe(input)
    expect(provider.id).toBe("acme")
    expect(provider.label).toBe("Acme")
    expect(typeof provider.getSessions).toBe("function")
  })

  it("preserves Host-coordinated callbacks without invoking or scheduling them", () => {
    const authorize = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["authorize"]>>,
      Parameters<NonNullable<PluginAuthProvider["authorize"]>>
    >()
    const exchange = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["exchange"]>>,
      Parameters<NonNullable<PluginAuthProvider["exchange"]>>
    >()
    const refresh = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["refresh"]>>,
      Parameters<NonNullable<PluginAuthProvider["refresh"]>>
    >()
    const revoke = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["revoke"]>>,
      Parameters<NonNullable<PluginAuthProvider["revoke"]>>
    >()
    const describe = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["describe"]>>,
      Parameters<NonNullable<PluginAuthProvider["describe"]>>
    >()
    const input: PluginAuthProvider = {
      id: "acme",
      label: "Acme",
      getSessions: async () => [],
      createSession: async () =>
        __makeSession({ accessToken: "t", account: { id: "u", label: "U" }, scopes: [] }),
      removeSession: async () => {},
      authorization: { clientId: "client", issuer: "https://issuer.test" },
      authorize,
      exchange,
      refresh,
      revoke,
      describe,
    }

    const provider = defineAuthProvider(input)
    expect(provider).toBe(input)
    expect(provider.authorization).toBe(input.authorization)
    for (const key of ["authorize", "exchange", "refresh", "revoke", "describe"] as const) {
      expect(provider[key]).toBe(input[key])
      expect(input[key]).not.toHaveBeenCalled()
    }
  })

  it("accepts a Host-managed provider without session callbacks", () => {
    const input = {
      management: "host" as const,
      id: "acme",
      label: "Acme",
      describe: jest.fn(async () => ({
        issuer: "https://issuer.test",
        clientId: "client",
        principal: { id: "user", kind: "user" as const },
        accountLabel: "User",
        scopes: [],
      })),
      refresh: jest.fn(async () => ({ accessToken: "fresh", scopes: [] })),
    }
    expect(defineAuthProvider(input)).toBe(input)
    expect(input.describe).not.toHaveBeenCalled()
    expect(input.refresh).not.toHaveBeenCalled()
    expect(input).not.toHaveProperty("getSessions")
  })

  it("type-checks both provider forms and rejects incomplete or mixed forms", () => {
    // Compile the actual helper against the shipped author declarations. No
    // workspace aliases or broad repository typecheck hide author-facing errors.
    const directory = resolve(process.cwd(), "packages/plugin-sdk/src/define")
    const fixture = resolve(directory, "auth-provider-typing-fixture.ts")
    const declarations = resolve(directory, "auth-provider-author-sdk.d.ts")
    const bundle = JSON.parse(
      readFileSync(resolve(process.cwd(), "crates/cognia-cli/assets/author-types.json"), "utf8")
    )
    const files = new Map<string, string>([
      [declarations, bundle.files["types/cognia-plugin-sdk.d.ts"]],
      [
        fixture,
        `
        import { defineAuthProvider } from "./define-auth-provider"
        const host = defineAuthProvider({
          management: "host", id: "acme", label: "Acme",
          describe: async (credentials) => ({ issuer: "https://issuer.test", clientId: "client",
            principal: { id: "user", kind: "user" }, accountLabel: "User", scopes: credentials.scopes }),
          refresh: async (lineage) => ({ accessToken: lineage.credentials.accessToken, scopes: [] }),
        })
        const marker: "host" = host.management
        const legacy = defineAuthProvider({ id: "old", label: "Old",
          getSessions: async () => [], createSession: async () => ({ id: "s", accessToken: "t",
            account: { id: "u", label: "U" }, scopes: [] }), removeSession: async () => {} })
        legacy.getSessions()
        // @ts-expect-error A provider must implement one complete form.
        defineAuthProvider({ id: "invalid", label: "Invalid" })
        // @ts-expect-error Host-managed providers require refresh.
        defineAuthProvider({ management: "host", id: "invalid", label: "Invalid", describe: host.describe })
        // @ts-expect-error Host-managed providers require describe.
        defineAuthProvider({ management: "host", id: "invalid", label: "Invalid", refresh: host.refresh })
        // @ts-expect-error The Host owns session callbacks.
        defineAuthProvider({ ...host, getSessions: async () => [] })
      `,
      ],
    ])
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: { "@cognia/plugin-contract/lib/plugin/api/auth-api": [declarations] },
    }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile.bind(host)
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (file) => files.has(file) || fileExists(file)
    host.getSourceFile = (file, version, onError, createNew) =>
      files.has(file)
        ? ts.createSourceFile(file, files.get(file)!, version, true)
        : getSourceFile(file, version, onError, createNew)
    const program = ts.createProgram([fixture], options, host)
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    ).toEqual([])
  })
})
