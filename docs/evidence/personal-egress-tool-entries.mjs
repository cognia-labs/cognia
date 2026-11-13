/** Verification-only control-flow audit. Runtime authorities remain in their owning modules. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
// Resolve the root workspace compiler: docs/ installs a native TypeScript
// without the JS API, and Node would find it first from docs/evidence.
const ts = createRequire(path.join(root, "package.json"))("typescript")
// A forwarding entry is audited separately from the authority it forwards to.
export const entries = [
  [
    "python-contribution-callback",
    "lib/plugin/bridge/_shared/python-backed-proxy.ts",
    "bindTransport",
    "runPersonalEgressOperation",
    "transport",
  ],
  [
    "terminal-module-process",
    "lib/terminal/agent-tools.ts",
    "runDockToolEgress",
    "runPersonalEgressOperation",
    "dispatch",
  ],
  [
    "plugin-capability",
    "lib/plugin/security/permission-guard.ts",
    "invokeEgressMethod",
    "runPersonalEgressOperation",
    "Reflect.apply",
  ],
  [
    "terminal-callback",
    "lib/plugin/api/terminal-api.ts",
    "doSpawn",
    "runPersonalEgressOperation",
    "spawnFromDock",
  ],
  [
    "shell-callback",
    "lib/plugin/core/transport.ts",
    "invokePluginShellApi",
    "runPersonalEgressOperation",
    "invokeBoundPluginApi",
  ],
  [
    "python-callback",
    "lib/plugin/core/manager.ts",
    "invokeNativeHost",
    "runPersonalEgressOperation",
    "withPluginExecutionContext",
  ],
  [
    "wasm-callback",
    "lib/plugin/core/wasm-loader.ts",
    "invokeWasmHost",
    "runPersonalEgressOperation",
    "withPluginExecutionContext",
  ],
  [
    "vscode-callback",
    "lib/plugin/core/vscode-loader.ts",
    "invokeVscodeRpc",
    "runPersonalEgressOperation",
    "withPluginExecutionContext",
  ],
  [
    "vscode-terminal",
    "lib/plugin/vscode-shim/terminal-handlers.ts",
    "createProcessTerminal",
    "runPersonalEgressOperation",
    "d.spawn",
  ],
  [
    "integration-http",
    "lib/integrations/action-runner.ts",
    "authenticatedRequest",
    "runPersonalEgressOperation",
    "requestOverride|defaultAuthenticatedRequest",
  ],
  [
    "integration-action",
    "lib/integrations/action-runner.ts",
    "runIntegrationActionJob",
    "assertPersonalEgress",
    "handler",
  ],
  [
    "knowledge-ranking",
    "lib/knowledge-base/agent-tools.ts",
    "rankKnowledgeDocuments",
    "runPersonalEgressOperation",
    "read",
  ],
  [
    "workflow-url",
    "lib/workflow/runtime/step-executor.ts",
    "executeWorkflowEgress",
    "runPersonalEgressOperation",
    "execute",
  ],
  [
    "configured-hooks",
    "sidecar/src/hooks/handlers/index.ts",
    "runHandlerUnchecked",
    "deps.personalEgressFenced",
    "runCommandDetached|runCommandHandler|runWebhookHandler|runPluginHookHandler|deps.executeNativeHandler",
  ],
  [
    "native",
    "sidecar/src/policy/permission/sdk-can-use-tool.ts",
    "createAnthropicCanUseTool",
    "personalToolDenied",
    "decidePermission|awaitApproval",
  ],
  [
    "ai-sdk",
    "sidecar/src/policy/permission/ai-sdk-gate.ts",
    "createToolPermissionGate",
    "personalToolDenied",
    "decidePermission|awaitApproval",
  ],
  [
    "cli-approval",
    "cli/src/agent/tool-host/broker.ts",
    "authorize",
    "personalToolDenial",
    "params.gate",
  ],
  [
    "cli-dispatch",
    "cli/src/agent/tool-host/broker.ts",
    "dispatch",
    "authorize",
    "params.execHostTool",
  ],
  [
    "plugin-ipc-module",
    "lib/claude/plugin-tool-ipc.ts",
    "runPluginToolExec",
    "assertPersonalToolEgress",
    "runModuleToolCall|runWebBuiltinTool",
  ],
  [
    "module",
    "lib/claude/tool-contributions.ts",
    "runContributedTool",
    "assertPersonalToolEgress",
    "family.run",
  ],
  [
    "plugin-tool",
    "lib/plugin/core/invoke-plugin-tool.ts",
    "invokeBoundPluginTool",
    "assertPersonalToolEgress|runPersonalEgressOperation",
    "tool.execute",
  ],
  [
    "mcp",
    "lib/mcp/runtime-gateway.ts",
    "callToolWithTimeout",
    "assertPersonalEgress",
    "client.callTool",
  ],
  [
    "browser",
    "lib/browser/submission-gate.ts",
    "gatedEngine",
    "runPersonalEgressOperation",
    "apply",
  ],
  [
    "browser-api",
    "lib/plugin/api/browser-api.ts",
    "createBrowserAPI",
    "gateBrowserEngine",
    "createPluginBrowserEngineFacade",
  ],
  [
    "sandbox",
    "lib/sandbox/session-runtime.ts",
    "executeSandbox",
    "personalEgressFenced|runPersonalEgressOperation",
    "executeOsSandbox|adapter.execute|runSandboxConnectionOperation",
  ],
  [
    "network",
    "lib/plugin/core/context.ts",
    "createNetworkAPI",
    "runPersonalEgressOperation",
    "fetch|invokePluginApi",
  ],
  [
    "external",
    "lib/ai/agent/external/manager.ts",
    "execute",
    "bindPersonalEgressSession|bindPersonalEgressOptions",
    "this.executePrepared|this.execute",
  ],
  [
    "external-stream",
    "lib/ai/agent/external/manager.ts",
    "executeStreaming",
    "bindPersonalEgressSession|bindPersonalEgressOptions",
    "this.executePreparedStreaming|this.executeStreaming",
  ],
  [
    "cli-hook-callback",
    "cli/src/hooks/run-hooks.ts",
    "runHooks",
    "runPersonalEgressOperation",
    "runCommand|spawnAsyncCommand",
  ],
  [
    "workspace-git-callback",
    "lib/plugin/workspace/acquire.ts",
    "runWorkspaceGit",
    "runPersonalEgressOperation",
    "dispatch",
  ],
  [
    "workspace-callback",
    "lib/plugin/api/workspace-api.ts",
    "acquire",
    "invokeEgressMethod",
    "acquireWorkspace|acquireBotWorkspace",
  ],
  [
    "scheduler-callback",
    "lib/plugin/api/scheduler-tasks.ts",
    "runUserScheduledTaskNow",
    "runPersonalEgressOperation",
    "runTaskNow",
  ],
  [
    "project-script",
    "lib/project-environment/executor.ts",
    "runScript",
    "runPersonalEgressOperation",
    "transport.call",
  ],
  [
    "webhook-retry",
    "lib/webhooks/delivery.ts",
    "deliverWebhook",
    "runPersonalEgressOperation",
    "proxyFetch",
  ],
  [
    "remote-log",
    "packages/logging/src/transports/remote-transport.ts",
    "send",
    "runLogEgress",
    "fetchImpl",
  ],
  [
    "otlp-log",
    "lib/logging/transports/otlp-log-transport.ts",
    "exportPayload",
    "runLogEgress",
    "fetchImpl",
  ],
  [
    "backup-github",
    "lib/data/destinations/github.ts",
    "uploadSnapshotToGithub",
    "runPersonalEgressOperation",
    "\\(deps\\.http \\?\\? backupHttpRequest\\)",
  ],
  [
    "backup-google",
    "lib/data/destinations/google-drive.ts",
    "driveContext",
    "runPersonalEgressOperation",
    "\\(deps\\.http \\?\\? backupHttpRequest\\)",
  ],
]

const capabilityEntries = [
  [
    "lib/plugin/api/vector-api.ts",
    [
      "createCollection",
      "deleteCollection",
      "listCollections",
      "getCollectionInfo",
      "addDocuments",
      "updateDocuments",
      "deleteDocuments",
      "search",
      "searchByEmbedding",
      "embed",
      "embedBatch",
      "getDocumentCount",
      "clearCollection",
    ],
  ],
  ["lib/plugin/api/terminal-api.ts", ["spawn", "runScript", "write"]],
  ["lib/plugin/api/git-api.ts", ["fetch", "pull", "push", "sync"]],
  ["lib/plugin/api/ocr-api.ts", ["extract", "extractFile", "extractScreen", "runSlashCommand"]],
  ["lib/plugin/api/share-api.ts", ["create", "revoke", "getStats"]],
  [
    "lib/connectors/plugin-api/connectors-api.ts",
    [
      "queryManagement",
      "manage",
      "fetchHistory",
      "resolveContacts",
      "getReadReceipt",
      "deleteMessage",
      "deleteEphemeralCard",
      "addReaction",
      "removeReaction",
      "unpinMessage",
      "setTyping",
      "createInstance",
      "updateInstance",
      "setInstanceEnabled",
    ],
  ],
  [
    "lib/plugin/api/automation-api.ts",
    ["performAction", "type", "paste", "keys", "launchApp", "getAppState", "getFocus"],
  ],
]
function capabilityPolicy(text, file, required) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let found = false
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      /^(?:createGuardedAPI|createApiGuardedAPI)$/.test(node.expression.getText(source))
    ) {
      const options = node.arguments[3]
      if (options && ts.isObjectLiteralExpression(options)) {
        const policy = options.properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "egressMethods"
        )
        if (
          policy &&
          ts.isPropertyAssignment(policy) &&
          ts.isArrayLiteralExpression(policy.initializer)
        ) {
          const names = new Set(
            policy.initializer.elements.filter(ts.isStringLiteral).map((e) => e.text)
          )
          found ||= required.every((name) => names.has(name))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Every syntactic path reaching a dispatch must have evaluated the gate first.
 * Branch joins intersect their surviving paths; throwing/returning paths end.
 * Nested callbacks inherit only gates evaluated before their creation.
 * Only a gate's callback argument is lexically admitted by that gate.
 */
export function audit(text, owner, gatePattern, dispatchPattern, file = "fixture.ts") {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const gate = new RegExp(`^(?:${gatePattern})$`)
  const dispatch = new RegExp(`(?:^|\\.)(?:${dispatchPattern})$`)
  const errors = []
  let checked = 0,
    owners = 0
  const callName = (node) => node.expression.getText(source)
  function expression(node, admitted) {
    if (!node) return admitted
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      body(node.body, admitted)
      return admitted
    }
    if (ts.isCallExpression(node)) {
      let state = expression(node.expression, admitted)
      const name = callName(node)
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          // Callback creation follows prior dominating checks; wrapper gates admit their callback.
          body(arg.body, state || gate.test(name))
        } else state = expression(arg, state)
      }
      if (dispatch.test(name)) {
        checked++
        if (!state)
          errors.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${name} is not dominated by ${gatePattern}`
          )
      }
      return state || gate.test(name)
    }
    if (ts.isConditionalExpression(node)) {
      const state = expression(node.condition, admitted)
      return expression(node.whenTrue, state) && expression(node.whenFalse, state)
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind)
    ) {
      const state = expression(node.left, admitted)
      expression(node.right, state)
      return state
    }
    let state = admitted
    ts.forEachChild(node, (child) => {
      state = expression(child, state)
    })
    return state
  }
  function statement(node, admitted) {
    if (ts.isFunctionDeclaration(node)) {
      if (node.body) body(node.body, false)
      return [admitted]
    }
    if (ts.isBlock(node)) return body(node, admitted)
    if (ts.isIfStatement(node)) {
      const state = expression(node.expression, admitted)
      return [
        ...statement(node.thenStatement, state),
        ...(node.elseStatement ? statement(node.elseStatement, state) : [state]),
      ]
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      expression(node.expression, admitted)
      return []
    }
    if (ts.isTryStatement(node)) {
      let paths = body(node.tryBlock, admitted)
      if (node.catchClause) paths.push(...body(node.catchClause.block, admitted))
      if (node.finallyBlock) paths = paths.flatMap((state) => body(node.finallyBlock, state))
      return paths
    }
    if (ts.isSwitchStatement(node)) {
      const state = expression(node.expression, admitted)
      return node.caseBlock.clauses.flatMap((clause) => sequence(clause.statements, state))
    }
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      if (node.expression) expression(node.expression, admitted)
      statement(node.statement, admitted)
      return [admitted]
    }
    return [expression(node, admitted)]
  }
  function sequence(statements, admitted) {
    let paths = [admitted]
    for (const item of statements) {
      if (!paths.length) break
      paths = statement(item, paths.every(Boolean))
    }
    return paths
  }
  function body(node, admitted) {
    return ts.isBlock(node) ? sequence(node.statements, admitted) : [expression(node, admitted)]
  }
  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name?.getText(source) === owner
    ) {
      const fn = ts.isVariableDeclaration(node) ? node.initializer : node
      if (fn?.body) {
        owners++
        body(fn.body, false)
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!owners) errors.push(`${file} missing entry ${owner}`)
  if (!checked) errors.push(`${file}#${owner} has no configured dispatch; update its contract`)
  return { checked, errors }
}

const runContextEntries = [
  ["lib/agent/plan/step-dispatch.ts", "invokeMcpTool", "`execution:plan:${runCtx.plan.id}`"],
  [
    "lib/workflow/nodes/integrations/index.ts",
    "invokeMcpTool",
    "`execution:workflow:${ctx.runId}`",
  ],
  ["lib/mcp/apps-runtime.ts", "defaultMcpRuntimeGateway.readResource", "credentialContext"],
]
/** A downstream gate cannot recover a producer dropped by its run-bound caller. */
export function auditRunMcpContext(text, file, dispatch, expected) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const errors = [],
    properties = []
  let checked = 0
  const name = (node) => node.name?.getText(source).replaceAll('"', "")
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === dispatch) {
      checked++
      const arg = node.arguments[0]
      const context =
        arg &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.find((p) => name(p) === "credentialContext")
      if (context) properties.push([context.name.getStart(source), context.name.end])
      let expression
      if (context && ts.isShorthandPropertyAssignment(context))
        expression = context.name.getText(source)
      else if (context && ts.isPropertyAssignment(context)) {
        if (ts.isObjectLiteralExpression(context.initializer)) {
          const run = context.initializer.properties.find((p) => name(p) === "executionRunId")
          if (run && ts.isPropertyAssignment(run)) expression = run.initializer.getText(source)
        } else expression = context.initializer.getText(source)
      }
      if (expression !== expected) errors.push(`${file}: ${dispatch} drops its Host run context`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!checked) errors.push(`${file}: missing run-bound MCP entry`)
  return { checked, errors, properties }
}

if (process.argv.includes("--self-test")) {
  const cases = [
    ["async function entry(){await gate(); return send()}", true],
    ["function entry(){return gate(ctx,()=>send())}", true],
    ["function entry(){if(flag) gate(); send()}", false],
    ["function entry(){send(); gate()}", false],
    ["function entry(){function sibling(){gate()} send()}", false],
    ["function entry(){try{gate()}catch{} send()}", false],
    ["function entry(){gate(); return ()=>send()}", true],
    ["function entry(){if(flag){gate()}else{return} send()}", true],
  ]
  for (const [text, accepted] of cases) {
    const result = audit(text, "entry", "gate", "send")
    if ((result.errors.length === 0) !== accepted)
      throw new Error(`Dominance regression: ${text}: ${result.errors}`)
  }
  for (const [text, accepted] of [
    ["invokeMcpTool({credentialContext:{executionRunId:run.id}})", true],
    ["invokeMcpTool({})", false],
    ['invokeMcpTool({credentialContext:{executionRunId:""}})', false],
    ["invokeMcpTool({credentialContext:{executionRunId:undefined}})", false],
  ])
    if (
      (auditRunMcpContext(text, "pin.ts", "invokeMcpTool", "run.id").errors.length === 0) !==
      accepted
    )
      throw new Error("Run MCP context regression")
  console.log(
    "Tool-entry dominance regressions: removal, conditional, early dispatch, sibling, catch and deferred callback pass"
  )
} else if (process.argv.includes("--mutation-check")) {
  for (const [family, file, owner, gate, dispatch] of entries) {
    const text = fs.readFileSync(path.join(root, file), "utf8")
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const edits = []
    const pattern = new RegExp(`^(?:${gate})$`)
    function visit(node) {
      if (ts.isCallExpression(node) && pattern.test(node.expression.getText(source)))
        edits.push([node.expression.getStart(source), node.expression.end])
      ts.forEachChild(node, visit)
    }
    visit(source)
    let mutated = text
    for (const [start, end] of edits.sort((a, b) => b[0] - a[0]))
      mutated = mutated.slice(0, start) + "__removedPersonalEgressGate" + mutated.slice(end)
    if (!edits.length || !audit(mutated, owner, gate, dispatch, file).errors.length)
      throw new Error(`Gate removal escaped: ${family}`)
  }
  for (const [file, required] of capabilityEntries) {
    const text = fs.readFileSync(path.join(root, file), "utf8")
    if (
      !capabilityPolicy(text, file, required) ||
      capabilityPolicy(text.replaceAll("egressMethods", "removedEgressMethods"), file, required)
    )
      throw new Error(`Capability policy removal escaped: ${file}`)
  }
  for (const [file, dispatch, expected] of runContextEntries) {
    const text = fs.readFileSync(path.join(root, file), "utf8")
    const result = auditRunMcpContext(text, file, dispatch, expected)
    let changed = text
    for (const [start, end] of result.properties.sort((a, b) => b[0] - a[0]))
      changed = changed.slice(0, start) + "removedContext" + changed.slice(end)
    if (
      result.errors.length ||
      !auditRunMcpContext(changed, file, dispatch, expected).errors.length
    )
      throw new Error(`Run context removal escaped: ${file}`)
  }
  console.log(
    `Tool-entry gate removal: ${entries.length + capabilityEntries.length + runContextEntries.length} source mutations rejected`
  )
} else if (process.argv.includes("--check")) {
  const results = entries.map(([, file, owner, gate, dispatch]) =>
    audit(fs.readFileSync(path.join(root, file), "utf8"), owner, gate, dispatch, file)
  )
  const errors = results.flatMap((result) => result.errors)
  for (const [file, dispatch, expected] of runContextEntries)
    errors.push(
      ...auditRunMcpContext(
        fs.readFileSync(path.join(root, file), "utf8"),
        file,
        dispatch,
        expected
      ).errors
    )
  for (const [file, required] of capabilityEntries)
    if (!capabilityPolicy(fs.readFileSync(path.join(root, file), "utf8"), file, required))
      errors.push(`${file}: missing capability egress policy`)
  if (errors.length) {
    console.error([...new Set(errors)].join("\n"))
    process.exitCode = 1
  } else
    console.log(
      `Tool-entry dominance: ${entries.length} contracts; ${results.reduce((sum, r) => sum + r.checked, 0)} dispatch sites pass`
    )
}
