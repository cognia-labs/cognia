#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import ts from "typescript"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// These libraries must be usable without the application source tree. The
// plugin SDK is intentionally a host facade and is governed by its own gate.
// Unlike root-loading rules, this boundary includes types and lazy imports.
export const HOST_INDEPENDENT_PACKAGES = [
  "error-parsers",
  "provider-types",
  "vector",
  "eval-core",
  "agent-contracts",
  "agent-runtime-kit",
  "agent-acp",
  "agent-codex",
  "agent-dsh",
  "agent-pi",
  "agent-aider",
  "agent-a2a",
  "agent-opencode",
  "agent-openclaude",
  "agent-crush",
  "agent-continue",
  "agent-rovo",
  "agent-codebuff",
  "agent-claude-code",
  "agent-orchestration",
]

// The report is a data-only view. Dataset configuration belongs to eval's
// application layer; these components must not access persistence or foreign
// stores. The run dialog may still own state in eval's UI store.
export const EVAL_UI_BOUNDARIES = [
  { file: "components/eval/eval-report-panel.tsx", forbidden: ["lib", "stores", "hooks", "types"] },
  { file: "components/eval/eval-dashboard.tsx", forbidden: ["lib/db", "stores"] },
  { file: "components/eval/dataset-detail.tsx", forbidden: ["lib/db", "stores"] },
  {
    file: "components/eval/blind-review-panel.tsx",
    forbidden: ["lib", "stores"],
    allowed: ["lib/ai/eval/review-service.ts", "lib/utils.ts"],
  },
  {
    file: "components/eval/eval-lab-workspace.tsx",
    forbidden: [
      "lib/ai/eval/browser-execution.ts",
      "lib/ai/eval/orchestrator.ts",
      "lib/ai/eval/artifact-crypto.ts",
      "lib/ai/eval/project-service.ts",
      "lib/ai/eval/recovery.ts",
      "lib/ai/eval/report-view.ts",
      "lib/ai/eval/execution-runtime.ts",
    ],
  },
  {
    file: "components/eval/run-config-dialog.tsx",
    forbidden: ["lib/db", "stores"],
    allowed: ["stores/eval"],
  },
]

function isWithin(parent, file) {
  const path = relative(parent, file)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "__fixtures__", "__mocks__"].includes(entry.name)
        ? []
        : sourceFiles(path)
    }
    return /\.[cm]?tsx?$/.test(entry.name) && !/\.(?:test|spec|stories)\./.test(entry.name)
      ? [path]
      : []
  })
}

export function extractModuleReferences(source, fileName = "source.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const references = []
  function visit(node) {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifier = node.arguments[0]
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      references.push({
        specifier: specifier.text,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return references
}

function moduleResolver(repoRoot) {
  const configPath = join(repoRoot, "tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  // Only resolution options are needed; don't enumerate the entire app's TS
  // program while checking the selected boundaries.
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    { ...ts.sys, readDirectory: () => [] },
    repoRoot
  )
  const cache = ts.createModuleResolutionCache(repoRoot, (path) => path, parsed.options)
  return (file, specifier) =>
    ts.resolveModuleName(specifier, file, parsed.options, ts.sys, cache).resolvedModule
      ?.resolvedFileName ??
    (specifier.startsWith("@/")
      ? resolve(repoRoot, specifier.slice(2))
      : specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : undefined)
}

export function findPackageBoundaryViolations(
  repoRoot = REPO_ROOT,
  packages = HOST_INDEPENDENT_PACKAGES
) {
  const resolveModule = moduleResolver(repoRoot)
  const packageRoot = join(repoRoot, "packages")
  const violations = []
  for (const name of packages) {
    for (const file of sourceFiles(join(packageRoot, name, "src"))) {
      for (const reference of extractModuleReferences(readFileSync(file, "utf8"), file)) {
        // Keep detecting direct host paths even when their target was deleted
        // or renamed; unresolved external packages belong to the typecheck.
        const target = resolveModule(file, reference.specifier)
        if (
          target &&
          isWithin(repoRoot, target) &&
          !isWithin(packageRoot, target) &&
          !target.split(sep).includes("node_modules")
        ) {
          violations.push({
            file: relative(repoRoot, file).split(sep).join("/"),
            ...reference,
            target: relative(repoRoot, target).split(sep).join("/"),
          })
        }
      }
    }
  }
  return violations
}

/** Source aliases must not hide missing dependencies or reverse contract ownership. */
export function findPackageManifestViolations(
  repoRoot = REPO_ROOT,
  packages = ["plugin-contract", "plugin-sdk", "agent-config-types"]
) {
  const violations = []
  for (const name of packages) {
    const directory = join(repoRoot, "packages", name)
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
    const declared = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
    }
    for (const file of sourceFiles(join(directory, "src"))) {
      for (const reference of extractModuleReferences(readFileSync(file, "utf8"), file)) {
        const dependency = reference.specifier.match(/^(@cognia\/[^/]+)/)?.[1]
        if (!dependency || dependency === manifest.name) continue
        const reversed =
          name === "plugin-contract" &&
          ["@cognia/plugin-sdk", "@cognia/agent-config-types"].includes(dependency)
        if (reversed || !declared[dependency]) {
          violations.push({
            file: relative(repoRoot, file).split(sep).join("/"),
            ...reference,
            rule: reversed ? "contract-upper-layer-dependency" : "undeclared-package-dependency",
            target: dependency,
          })
        }
      }
    }
  }
  return violations
}

export function findEvalUiBoundaryViolations(repoRoot = REPO_ROOT, rules = EVAL_UI_BOUNDARIES) {
  const resolveModule = moduleResolver(repoRoot)
  return rules.flatMap(({ file, forbidden, allowed = [] }) => {
    const path = join(repoRoot, file)
    return extractModuleReferences(readFileSync(path, "utf8"), path).flatMap((reference) => {
      const target = resolveModule(path, reference.specifier)
      return target &&
        forbidden.some((directory) => isWithin(join(repoRoot, directory), target)) &&
        !allowed.some((directory) => isWithin(join(repoRoot, directory), target))
        ? [{ file, ...reference, target: relative(repoRoot, target).split(sep).join("/") }]
        : []
    })
  })
}

/** Reverse boundary: application modules assemble ports, packages own runtime state. */
export function findAgentHostBoundaryViolations(repoRoot = REPO_ROOT) {
  const resolveModule = moduleResolver(repoRoot)
  const violations = []
  const manager = "lib/ai/agent/external/manager.ts"
  const directories = ["lib/ai/agent/external/integrations", "lib/ai/agent/external/lifecycle"]
  const hostAuthority = new Set([
    "lib/ai/agent/external/lifecycle/native-runtime-host.ts",
    "lib/ai/agent/external/lifecycle/launch-preparation.ts",
    "lib/ai/agent/external/lifecycle/isolated-terminal-env.ts",
  ])
  const files = directories.flatMap((directory) =>
    existsSync(join(repoRoot, directory)) ? sourceFiles(join(repoRoot, directory)) : []
  )
  const recipeFacades = [
    "config/gateway-task.ts",
    "config/model-slots.ts",
    "config/pi-subagents.ts",
  ].map((file) => "lib/ai/agent/external/" + file)
  for (const file of recipeFacades)
    if (existsSync(join(repoRoot, file))) files.push(join(repoRoot, file))
  if (existsSync(join(repoRoot, manager))) files.push(join(repoRoot, manager))
  for (const absolute of files) {
    const file = relative(repoRoot, absolute).split(sep).join("/")
    if (hostAuthority.has(file)) continue
    const source = readFileSync(absolute, "utf8")
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const add = (node, rule) =>
      violations.push({
        file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        rule,
      })
    if (file === manager) {
      for (const reference of extractModuleReferences(source, file)) {
        const target = resolveModule(absolute, reference.specifier)
        const integration = target && relative(join(repoRoot, "packages"), target).split(sep)[0]
        if (
          (integration?.startsWith("agent-") &&
            !["agent-contracts", "agent-runtime-kit"].includes(integration)) ||
          /^@cognia\/agent-(?!contracts(?:\/|$)|runtime-kit(?:\/|$))/.test(reference.specifier)
        )
          violations.push({ file, line: reference.line, rule: "manager-vendor-import" })
        if (
          /integrations\//.test(reference.specifier) &&
          !reference.specifier.endsWith("integrations/register")
        )
          violations.push({ file, line: reference.line, rule: "manager-vendor-import" })
        if (reference.specifier.endsWith("config/pi-subagents"))
          violations.push({ file, line: reference.line, rule: "manager-vendor-import" })
      }
    }
    const aliases = new Map()
    const collectAliases = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        aliases.set(node.name.text, node.initializer)
      ts.forEachChild(node, collectAliases)
    }
    collectAliases(ast)
    const runtimeField = (node, seen = new Set()) => {
      if (ts.isPropertyAccessExpression(node))
        return ["preset", "runtime", "runtimeId"].includes(node.name.text)
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
        return ["preset", "runtime", "runtimeId"].includes(node.argumentExpression.text)
      if (ts.isIdentifier(node) && ["preset", "runtime", "runtimeId"].includes(node.text))
        return true
      if (ts.isIdentifier(node) && !seen.has(node.text) && aliases.has(node.text)) {
        seen.add(node.text)
        return runtimeField(aliases.get(node.text), seen)
      }
      return false
    }
    const inHostTraversal = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isFunctionDeclaration(parent) && parent.name?.text === "hostDeps")
          return file.endsWith("/config/pi-subagents.ts")
      return false
    }
    const protocol = (node) =>
      (ts.isPropertyAccessExpression(node) && node.name.text === "protocol") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "protocol")
    function visit(node) {
      if (file === manager || recipeFacades.includes(file)) {
        if (
          (ts.isBinaryExpression(node) &&
            ((runtimeField(node.left) && ts.isStringLiteralLike(node.right)) ||
              (runtimeField(node.right) && ts.isStringLiteralLike(node.left)))) ||
          (ts.isSwitchStatement(node) && runtimeField(node.expression))
        )
          add(node, "manager-runtime-branch")
      }
      if (file === manager) {
        if (
          ts.isBinaryExpression(node) &&
          ((protocol(node.left) && ts.isStringLiteralLike(node.right)) ||
            (protocol(node.right) && ts.isStringLiteralLike(node.left)))
        )
          add(node, "manager-protocol-branch")
        if (ts.isSwitchStatement(node) && protocol(node.expression))
          add(node, "manager-protocol-branch")
      } else {
        if (
          ts.isForStatement(node) ||
          ts.isForOfStatement(node) ||
          ts.isForInStatement(node) ||
          ts.isWhileStatement(node) ||
          ts.isDoStatement(node)
        )
          if (!inHostTraversal(node)) add(node, "host-runtime-loop")
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          const error = node.heritageClauses?.some((clause) =>
            clause.types.some((type) => type.expression.getText(ast) === "Error")
          )
          const facade =
            Boolean(node.heritageClauses?.length) &&
            node.members.every((member) => ts.isConstructorDeclaration(member))
          if (!error && !facade) add(node, "host-runtime-state")
        }
        if (ts.isNewExpression(node) && ["Map", "Set"].includes(node.expression.getText(ast))) {
          // SIWC owns account-bound credential/process leases. Only those two
          // existing authorization tables are allowed here, never a new driver map.
          const authLease =
            file === "lib/ai/agent/external/integrations/siwc.ts" &&
            ts.isVariableDeclaration(node.parent) &&
            ["processes", "bound"].includes(node.parent.name.getText(ast))
          if (!authLease) add(node, "host-runtime-state")
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  for (const name of [
    "hermes-acp-bridge",
    "hermes-gateway-probe",
    "agent-path",
    "codex-model-catalog",
  ]) {
    const file = "cli/src/runtime/external/" + name + ".ts"
    if (!existsSync(join(repoRoot, file))) continue
    const ast = ts.createSourceFile(
      file,
      readFileSync(join(repoRoot, file), "utf8"),
      ts.ScriptTarget.Latest,
      true
    )
    const expected =
      name === "agent-path"
        ? "@cognia/agent-runtime-kit/agent-path"
        : name === "codex-model-catalog"
          ? "@cognia/agent-codex/model-catalog"
          : "@cognia/agent-acp/" + name
    if (
      ast.statements.some(
        (statement) =>
          !ts.isExportDeclaration(statement) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteralLike(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== expected
      )
    )
      violations.push({ file, line: 1, rule: "native-compatibility-entry" })
  }
  const devinFile = "cli/src/runtime/external/devin-mcp-config.ts"
  if (existsSync(join(repoRoot, devinFile))) {
    const ast = ts.createSourceFile(
      devinFile,
      readFileSync(join(repoRoot, devinFile), "utf8"),
      ts.ScriptTarget.Latest,
      true
    )
    const visit = (node) => {
      if (
        (ts.isFunctionDeclaration(node) &&
          [
            "parseJsonc",
            "parseDevinJsonc",
            "serverMap",
            "injectedServers",
            "projectDevinMcpConfig",
          ].includes(node.name?.text)) ||
        (ts.isCallExpression(node) && node.expression.getText(ast) === "JSON.parse")
      )
        violations.push({
          file: devinFile,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          rule: "host-vendor-configuration",
        })
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return violations
}

export function main() {
  const violations = [
    ...findPackageBoundaryViolations(),
    ...findPackageManifestViolations(),
    ...findEvalUiBoundaryViolations(),
    ...findAgentHostBoundaryViolations(),
  ]
  if (violations.length) {
    console.error(`[package-boundaries] ${violations.length} boundary/dependency violation(s):`)
    for (const { file, line, specifier, target, rule } of violations) {
      console.error(
        `  ${file}:${line}: ${rule ?? specifier} -> ${target ?? "package-owned runtime required"}`
      )
    }
    return 1
  }
  console.log(
    `[package-boundaries] OK: ${HOST_INDEPENDENT_PACKAGES.length} packages and ${EVAL_UI_BOUNDARIES.length} eval UI boundaries preserved.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
