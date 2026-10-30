/** @jest-environment node */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globSync } from "glob"
import ts from "typescript"

const ROOT = join(__dirname, "..", "..")
const TOKEN_ENTRY = "lib/connectors/adapters/lark/auth.ts"
const PURPOSES = new Set(["transport", "service-data", "adapter-admin"])
const LABELLED_HELPERS = new Set(["larkTenantRequest", "withTatRefresh", "getTenantToken"])

function isTypeReference(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (ts.isTypeNode(current)) return true
  return false
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  return (
    ts.isImportSpecifier(parent) ||
    ((ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === node) ||
    ((ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  )
}

function violations(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string>()
  const failures: string[] = []
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements)
        aliases.set(item.name.text, item.propertyName?.text ?? item.name.text)
    }
  }
  const collectBindingAliases = (node: ts.Node) => {
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      node.propertyName &&
      (ts.isIdentifier(node.propertyName) || ts.isStringLiteral(node.propertyName))
    )
      aliases.set(node.name.text, node.propertyName.text)
    ts.forEachChild(node, collectBindingAliases)
  }
  collectBindingAliases(ast)
  const referenceNameOf = (node: ts.Node): string | undefined =>
    ts.isIdentifier(node)
      ? (aliases.get(node.text) ?? node.text)
      : ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined
  const visit = (node: ts.Node) => {
    const referenceName = referenceNameOf(node)
    if (
      referenceName &&
      LABELLED_HELPERS.has(referenceName) &&
      !isTypeReference(node) &&
      !(
        ts.isIdentifier(node) &&
        (isDeclarationName(node) ||
          (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
      ) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
      failures.push(
        `${file}:${line}: ${referenceName} must be called with a purpose, not passed as a value`
      )
    }
    if (ts.isCallExpression(node)) {
      const name = referenceNameOf(node.expression)
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
      if (name === "getTenantAccessToken" && file !== TOKEN_ENTRY)
        failures.push(`${file}:${line}: raw tenant token outside labelled entry`)
      const index =
        name === "larkTenantRequest"
          ? 4
          : name === "withTatRefresh" ||
              name === "getTenantToken" ||
              name === "getTenantAccessToken"
            ? 1
            : file === "lib/connectors/adapters/lark/index.ts" && name === "doRequest"
              ? 0
              : undefined
      if (index !== undefined) {
        const purpose = node.arguments[index]
        if (
          !purpose ||
          !(ts.isStringLiteral(purpose)
            ? PURPOSES.has(purpose.text)
            : ts.isIdentifier(purpose) && purpose.text === "purpose")
        )
          failures.push(`${file}:${line}: ${name} requires an explicit purpose`)
      }
    }
    if (
      file === "lib/connectors/adapters/lark/index.ts" &&
      ts.isIdentifier(node) &&
      node.text === "doRequest" &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    )
      failures.push(`${file}: doRequest must be called with a purpose, not passed unbound`)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return failures
}

describe("tenant token purpose gate", () => {
  it("routes every lib tenant token through the labelled entry and labels every request/retry", () => {
    const files = [
      ...globSync("lib/**/*.ts", {
        cwd: ROOT,
        ignore: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
      }),
      "scripts/lark-live-smoke.mts",
    ]
    expect(files.length).toBeGreaterThan(100)
    expect(
      files.flatMap((file) => violations(file, readFileSync(join(ROOT, file), "utf8")))
    ).toEqual([])
  })

  it("detects aliases, property calls and multiline calls without mistaking comments for calls", () => {
    expect(
      violations(
        "lib/example.ts",
        `
      import { getTenantAccessToken as raw } from "./auth"
      raw(creds, "transport")
      auth.getTenantAccessToken(creds, "transport")
      larkTenantRequest(creds, "GET", "/data", undefined)
      withTatRefresh(creds, async () => {})
      getTenantToken(creds, undefined)
      // getTenantAccessToken(creds)
    `
      )
    ).toHaveLength(5)
    expect(
      violations(
        TOKEN_ENTRY,
        `
      getTenantAccessToken(creds, purpose)
      getTenantToken(creds, "transport")
      larkTenantRequest(creds, "GET", "/data", undefined, "service-data")
      withTatRefresh(creds, purpose, async () => {})
    `
      )
    ).toEqual([])
    expect(
      violations("lib/connectors/adapters/lark/index.ts", 'bind(doRequest); doRequest("GET", path)')
    ).toHaveLength(2)
  })

  it.each(["larkTenantRequest", "withTatRefresh", "getTenantToken"])(
    "rejects %s escaping through defaults, assignments, shorthand or spreads",
    (helper) => {
      expect(
        violations(
          "lib/example.ts",
          `
        import { ${helper} as helper } from "./api"
        const defaults = { request: helper }
        const request = helper
        install(helper)
        const deps = { ...{ request: helper } }
        const shorthand = { ${helper} }
        const spread = { ...api.${helper} }
        const indexed = api["${helper}"]
        function create(request = helper) {}
        const { ${helper}: destructured } = await import("./api")
        const escaped = destructured
      `
        )
      ).toHaveLength(9)
      expect(
        violations(
          "lib/example.ts",
          `
        import { ${helper} } from "./api"
        type Request = typeof ${helper}
      `
        )
      ).toEqual([])
      expect(violations("lib/example.ts", `api["${helper}"]()`)).toHaveLength(1)
    }
  )

  it("accepts typed injected request wrappers that forward a required purpose", () => {
    expect(
      violations(
        "lib/example.ts",
        `
      import { larkTenantRequest, type LarkTenantRequest } from "./http"
      interface Dependencies { request: LarkTenantRequest }
      const deps: Dependencies = {
        request: (creds, method, path, body, purpose, options) =>
          larkTenantRequest(creds, method, path, body, purpose, options),
      }
      deps.request(creds, "GET", "/im/v1/chats", undefined, "service-data")
    `
      )
    ).toEqual([])
  })
})
