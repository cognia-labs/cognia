/** @jest-environment node */
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const root = join(__dirname, "../..")
const launches = new Set([
  "execute",
  "executeStreaming",
  "launchChildRun",
  "createExecutionRun",
  "adoptExecutionRun",
  "executeRunWorkflowTyped",
  "executeDeployedWorkflow",
  "executeAgent",
  "executeAgentTurn",
  "executeAgentTurnFromRenderer",
  "dispatchTeammate",
  "startSquadRun",
  "runPluginAgentTurn",
  "dispatchSubagent",
  "dispatchSubagentAsChildRun",
  "runPluginAgent",
  "runPluginAgentStreamed",
  "runAndCaptureAssistantReply",
  "startToolExecutionRun",
  "startJobExecutionRun",
  "runGoalLoopHeadless",
  "createCreatorTurnRunner",
  "startDispatchRun",
])

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", ".next", "out", "test-support"].includes(entry.name)) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path)
    return /\.[cm]?tsx?$/.test(path) && !/\.(?:test|spec)\.[cm]?tsx?$|\.d\.ts$|generated/.test(path)
      ? [path]
      : []
  })
}

function calls(source: string, file = "source.ts"): Map<string, number> {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const aliases = new Map<string, string>()
  const result = new Map<string, number>()
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node))
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression)
        ? (aliases.get(expression.text) ?? expression.text)
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined
      if (name) result.set(name, (result.get(name) ?? 0) + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return result
}

// These are the authoritative seams; callers are inventoried separately below.
// Removing a gate from any seam must be observable even if its module stays imported.
const seams: Record<string, string[]> = {
  "lib/execution/launch-child-run.ts": ["resolveRunAuthority"],
  "lib/execution/acting-authority.ts": ["resolveRunAuthority", "persistRunAuthority"],
  "lib/db/execution-runs.ts": ["resolveRunAuthority"],
  "hooks/chat/use-claude-chat-controller.ts": [
    "ensureDirectChatExecutionRun",
    "enforceRunAuthorityOnSendOptions",
  ],
  "lib/execution/direct-chat-run.ts": ["ensureDirectChatExecutionRun"],
  "lib/chat/room/production-deps.ts": ["startToolExecutionRun"],
  "lib/execution/workflow-bridge.ts": ["createExecutionRun"],
  "lib/workflow/agent-tools.ts": ["executeRunWorkflowTyped"],
  "lib/plugin/api/workflow-author-api.ts": ["executeRunWorkflowTyped"],
  "lib/workflow/publish/run-workflow-typed-tool.ts": [
    "authorityParentRunId",
    "executeDeployedWorkflow",
  ],
  "lib/claude/build-options.ts": ["resolveRunAuthority", "enforceRunAuthorityOnSendOptions"],
  "lib/ai/agent/execution/agent-execution-service.ts": [
    "resolveRunAuthority",
    "persistRunAuthority",
  ],
  "lib/ai/agent/external/manager.ts": ["enforceExternalRunAuthority"],
  "lib/ai/agent/external/policy/run-authority.ts": ["resolveRunAuthority", "persistRunAuthority"],
  "lib/plugin/agent-sdk/run.ts": ["pluginExecutionContext"],
  "lib/ai/agent/external/runtimes/remote/remote-run-service.ts": ["bindExternalRunAuthority"],
  "lib/agent/plan/step-dispatch.ts": ["startToolExecutionRun"],
  "lib/squads/workflow-nodes/index.ts": ["startToolExecutionRun"],
  "lib/squads/workers/remote-worker-policy.ts": ["deriveExternalSessionPermission"],
  "lib/plugin/api/external-agent-api.ts": ["startToolExecutionRun"],
  "lib/scheduler/executors/index.ts": ["getExecutionRun"],
  "lib/plugin/api/agent-turn.ts": ["enforceRunAuthorityOnSendOptions"],
  "lib/squads/teammate/dispatch-teammate.ts": [
    "enforceRunAuthorityOnSendOptions",
    "resolveRunAuthority",
  ],
  "lib/squads/squad/squad-run-records.ts": ["resolveRunAuthority"],
  "lib/work-submission/service.ts": ["resolveRunAuthority"],
  "lib/creator/agent-turn-runner.ts": ["enforceRunAuthorityOnSendOptions"],
  "lib/scheduler/executors/goal-headless-runner.ts": ["startToolExecutionRun"],
  "sidecar/src/runtimes/claude-agent-sdk/options.ts": ["enforceNativeRunAuthority"],
}

function missingGates(source: string, required: string[]): string[] {
  const found = calls(source)
  return required.filter(
    (gate) =>
      (found.get(gate) ?? 0) !==
      (gate === "enforceExternalRunAuthority" || gate === "pluginExecutionContext"
        ? 2
        : gate === "deriveExternalSessionPermission"
          ? 3
          : gate === "resolveRunAuthority" &&
              (source.includes("export async function createExecutionRun(") ||
                source.includes("export async function resolveSendOptions("))
            ? 2
            : 1)
  )
}

it("keeps asynchronous module loading outside authority transactions", () => {
  for (const file of [
    "lib/execution/acting-authority.ts",
    "lib/execution/run-authority.ts",
    "lib/db/execution-runs.ts",
    "lib/squads/squad/squad-run-records.ts",
    "lib/work-submission/service.ts",
  ]) {
    const source = readFileSync(join(root, file), "utf8")
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const imports: number[] = []
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "transaction"
      )
        for (const argument of node.arguments)
          if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
            const check = (child: ts.Node) => {
              if (
                ts.isCallExpression(child) &&
                child.expression.kind === ts.SyntaxKind.ImportKeyword
              )
                imports.push(child.pos)
              ts.forEachChild(child, check)
            }
            check(argument.body)
          }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    expect({ file, imports }).toEqual({ file, imports: [] })
  }
})

it("inventories every agent launch call, including aliases and parented row writers", () => {
  const inventory = [
    "app",
    "cli/src",
    "components",
    "hooks",
    "lib",
    "packages",
    "sidecar/src",
    "stores",
    "types",
  ]
    .flatMap((path) => files(join(root, path)))
    .flatMap((path) =>
      [...calls(readFileSync(path, "utf8"), path)]
        .filter(([name]) => launches.has(name))
        .map(([call, count]) => ({ file: relative(root, path), call, count }))
    )
    .sort((a, b) => `${a.file}:${a.call}`.localeCompare(`${b.file}:${b.call}`))
  const reviewed = JSON.parse(
    readFileSync(join(root, "docs/evidence/2026-11-13-adr0243-3a-launch-calls.json"), "utf8")
  )
  expect(inventory).toEqual(reviewed)
})

it("classifies the added AI-SDK execute as an existing tool-search callback", () => {
  // Dev's third execute call delegates to search.execute after worker admission;
  // it searches the tool catalog and starts no agent or separate run tree.
  const source = readFileSync(join(root, "sidecar/src/runtimes/ai-sdk/index.ts"), "utf8")
  expect(source).toContain("const execute = search?.execute")
  expect(source).toContain(
    "await workerAdmission.admit(AI_SDK_TOOL_SEARCH_NAME, context.toolCallId)"
  )
  expect(calls(source).get("execute")).toBe(3)
})

it.each(Object.entries(seams))(
  "requires live gate calls in %s and rejects removal mutations",
  (path, gates) => {
    const source = readFileSync(join(root, path), "utf8")
    expect(missingGates(source, gates)).toEqual([])
    for (const gate of gates) {
      const ast = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true)
      const expressions: ts.Expression[] = []
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === gate
        )
          expressions.push(node.expression)
        ts.forEachChild(node, visit)
      }
      visit(ast)
      expect(expressions.length).toBeGreaterThan(0)
      for (const expression of expressions) {
        const mutation =
          source.slice(0, expression.getStart(ast)) +
          `removed_${gate}` +
          source.slice(expression.end)
        expect(missingGates(mutation, gates)).toContain(gate)
      }
    }
  }
)

const requiredMatrixFamilies = [
  "native dispatch",
  "SDK-native subagents",
  "Squad start",
  "Squad delegation",
  "local teammate",
  "remote Squad worker policy",
  "external teammate",
  "workflow agent node",
  "ensemble",
  "subworkflow",
  "typed workflow tool",
  "Codex external",
  "ACP external",
  "remote external",
  "plugin turn",
  "plugin SDK",
  "plugin SDK streamed",
  "Best-of-N",
  "Bot descendant",
  "goal",
  "scheduler",
  "Creator",
  "room",
  "headless person agent",
  "coordinator",
  "direct chat",
]

function matrixFamilies(source: string) {
  const ast = ts.createSourceFile("matrix.test.ts", source, ts.ScriptTarget.Latest, true)
  const families: Array<{ name: string; start: number; end: number }> = []
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === "family" &&
      ts.isStringLiteral(node.initializer)
    )
      families.push({
        name: node.initializer.text,
        start: node.parent.getStart(ast),
        end: node.parent.end,
      })
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return families
}

it("requires every behavioral family row and rejects individual row removal", () => {
  const source = readFileSync(join(root, "lib/execution/run-authority-matrix.test.ts"), "utf8")
  const families = matrixFamilies(source)
  expect(families.map((row) => row.name).sort()).toEqual([...requiredMatrixFamilies].sort())
  expect(source).toContain("it.each(families)")
  for (const row of families) {
    const mutation = source.slice(0, row.start) + source.slice(row.end)
    expect(matrixFamilies(mutation).map((item) => item.name)).not.toContain(row.name)
  }
})

/** Inventory every resolver boundary, including aliases and forwarded contexts. */
function optionResolutionSites(
  source: string,
  file: string
): Array<{ caller: string; shape: string }> {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const aliases = new Set(["resolveSendOptions"])
  const nodes: ts.Node[] = []
  const collect = (node: ts.Node) => {
    nodes.push(node)
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName?.text ?? node.name.text) === "resolveSendOptions"
    )
      aliases.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(ast)
  let previous: number
  do {
    previous = aliases.size
    for (const node of nodes) {
      if (
        !(ts.isVariableDeclaration(node) || ts.isParameter(node)) ||
        !ts.isIdentifier(node.name) ||
        !node.initializer
      )
        continue
      const refersToResolver = (value: ts.Node): boolean =>
        ts.isIdentifier(value)
          ? aliases.has(value.text)
          : ts.isBinaryExpression(value)
            ? refersToResolver(value.left) || refersToResolver(value.right)
            : ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
              ? refersToResolver(value.expression)
              : false
      if (refersToResolver(node.initializer)) aliases.add(node.name.text)
    }
  } while (previous !== aliases.size)
  const sites: Array<{ caller: string; shape: string }> = []
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue
    const expr = node.expression
    if (
      !(ts.isIdentifier(expr) && aliases.has(expr.text)) &&
      !(ts.isPropertyAccessExpression(expr) && expr.name.text === "resolveSendOptions")
    )
      continue
    const argument = node.arguments[0]
    let identity = false,
      credential = false,
      forwarded = Boolean(argument && !ts.isObjectLiteralExpression(argument))
    const inspect = (child: ts.Node) => {
      if (ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child)) {
        const name = child.name.getText(ast)
        identity ||= name === "executionIdentity"
        credential ||= name === "executionRunId"
      }
      if (ts.isSpreadAssignment(child) && ts.isIdentifier(child.expression)) forwarded = true
      ts.forEachChild(child, inspect)
    }
    if (argument) inspect(argument)
    sites.push({
      caller: `${file}#${sites.length + 1}`,
      shape: identity
        ? "explicit-id"
        : credential
          ? "credential-id"
          : forwarded
            ? "forwarded"
            : "no-id",
    })
  }
  return sites
}

it("requires each options caller and identity shape in the N7 row-source audit", () => {
  const ledger = readFileSync(join(root, "docs/evidence/2026-11-13-adr-0243-phase3a.md"), "utf8")
  const table =
    ledger.split("<!-- N7-OPTIONS-AUDIT -->")[1]?.split("<!-- /N7-OPTIONS-AUDIT -->")[0] ?? ""
  const reviewed = [
    ...table.matchAll(
      /^\|\s+`([^`]+#\d+)`\s+\|[^\n]+\[(explicit-id|credential-id|forwarded|no-id)\]\s+\|$/gm
    ),
  ]
    .map((match) => ({ caller: match[1], shape: match[2] }))
    .sort((a, b) => a.caller.localeCompare(b.caller))
  const actual = [
    "app",
    "cli/src",
    "components",
    "hooks",
    "lib",
    "packages",
    "sidecar/src",
    "stores",
    "types",
  ]
    .flatMap((path) => files(join(root, path)))
    .flatMap((path) => optionResolutionSites(readFileSync(path, "utf8"), relative(root, path)))
    .sort((a, b) => a.caller.localeCompare(b.caller))
  expect(actual.length).toBeGreaterThan(20)
  expect(actual).toEqual(reviewed)
})

it("detects new resolver callers, imported aliases and adding identity to an existing caller", () => {
  expect(
    optionResolutionSites(
      'import { resolveSendOptions as build } from "x"; build({ executionIdentity: { runId: "missing" } })',
      "new.ts"
    )
  ).toEqual([{ caller: "new.ts#1", shape: "explicit-id" }])
  expect(
    optionResolutionSites(
      "const build = deps.resolveOptions ?? resolveSendOptions; build(ctx)",
      "forward.ts"
    )
  ).toEqual([{ caller: "forward.ts#1", shape: "forwarded" }])
  expect(optionResolutionSites("deps.resolveSendOptions({ session })", "old.ts")).not.toEqual(
    optionResolutionSites(
      "deps.resolveSendOptions({ session, executionIdentity: { runId } })",
      "old.ts"
    )
  )
})

it("keeps handoff turnOptions dormant: no production sender produces the field", () => {
  const producers: string[] = []
  for (const directory of ["cli/src", "lib", "packages"]) {
    for (const file of files(join(root, directory))) {
      const ast = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
      )
      const visit = (node: ts.Node) => {
        if (
          (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
          node.name.getText(ast).replace(/["']/g, "") === "turnOptions"
        )
          producers.push(relative(root, file))
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.name.text === "turnOptions"
        )
          producers.push(relative(root, file))
        ts.forEachChild(node, visit)
      }
      visit(ast)
    }
  }
  expect(producers).toEqual([])
})
