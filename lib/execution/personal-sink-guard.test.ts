/** @jest-environment node */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globSync } from "glob"
import ts from "typescript"

const ROOT = join(__dirname, "..", "..")

// Reviewed call-site inventory is separate data so every added writer has a
// file, enclosing function and operation to classify in review.
import reviewedSites from "./personal-sink-sites.json"
const CONTENT_SINKS = new Set([
  "send",
  "fetch",
  "post",
  "notify",
  "emitNotification",
  "notifyConversationOverIM",
  "createSharedSession",
  "enqueueGoverned",
  "enqueueGovernedMany",
  "enqueueAuthorized",
  "sendNow",
  "deliver",
  "addIssueComment",
  "prepareEgress",
  "edit",
  "stream",
  "streamReply",
  "sendFile",
  "sendVoice",
  "uploadFile",
  "startStream",
  "patchStream",
  "endStream",
  "updateCard",
  "planDelivery",
  "planUnplannedStream",
  "planOutboundToolCall",
  "answerWithOutboundPolicy",
  "planOutboundAsk",
  "planIntegrationWrite",
  "planBrowserSubmission",
  "runLarkCli",
  "appendSessionEvent",
  "appendSessionRunEvent",
  "postSessionRunLiveFrame",
  "uploadSessionAttachment",
  "createShareLink",
  "updateShareLink",
  "buildChatShare",
  "buildMultiChatShare",
  "convertLocalSessionToShared",
  "openRunPresentation",
  "updateRunPresentation",
  "finishRunPresentation",
  "presentation:open",
  "presentation:update",
  "presentation:finish",
])

function sinkSites(text: string): string {
  const source = ts.createSourceFile("sink.ts", text, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string>()
  const counts: Record<string, number> = {}
  const name = (node: ts.Node): string | undefined => {
    if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text
    if (ts.isPropertyAccessExpression(node)) {
      const method = node.name.text
      if (
        ["open", "update", "finish"].includes(method) &&
        /driver$/i.test(node.expression.getText(source))
      )
        return `presentation:${method}`
      return method
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const method = node.argumentExpression.text
      return ["open", "update", "finish"].includes(method) &&
        /driver$/i.test(node.expression.getText(source))
        ? `presentation:${method}`
        : method
    }
    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node))
      return name(node.expression)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "bind"
    )
      return name(node.expression.expression)
    return undefined
  }
  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node))
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const original = name(node.initializer)
        if (original) aliases.set(node.name.text, original)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements)
          if (ts.isIdentifier(element.name)) {
            const original =
              element.propertyName?.getText(source).replace(/["']/g, "") ?? element.name.text
            aliases.set(
              element.name.text,
              ["open", "update", "finish"].includes(original) &&
                /driver$/i.test(node.initializer.getText(source))
                ? `presentation:${original}`
                : original
            )
          }
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const called = name(node.expression)
      if (called && CONTENT_SINKS.has(called)) counts[called] = (counts[called] ?? 0) + 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return Object.keys(counts)
    .sort()
    .map((key) => `${key}:${counts[key]}`)
    .join(";")
}

function sources() {
  return globSync(
    "{app,components,hooks,lib,packages,plugins,stores,cli,sidecar/src}/**/*.{ts,tsx}",
    {
      cwd: ROOT,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
        "**/__tests__/**",
        "**/*.test.*",
        "**/*.spec.*",
        "**/*.d.ts",
      ],
    }
  ).sort()
}

function callSiteInventory(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string>()
  const sites: string[] = []
  const counts = new Map<string, number>()
  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node))
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      let value = node.initializer
      if (
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === "bind"
      )
        value = value.expression.expression
      if (ts.isPropertyAccessExpression(value))
        aliases.set(
          node.name.text,
          ["open", "update", "finish"].includes(value.name.text) &&
            /driver$/i.test(value.expression.getText(source))
            ? `presentation:${value.name.text}`
            : value.name.text
        )
      else if (ts.isIdentifier(value))
        aliases.set(node.name.text, aliases.get(value.text) ?? value.text)
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name))
      for (const element of node.name.elements)
        if (ts.isIdentifier(element.name)) {
          const method =
            element.propertyName?.getText(source).replace(/["']/g, "") ?? element.name.text
          aliases.set(
            element.name.text,
            ["open", "update", "finish"].includes(method) &&
              node.initializer &&
              /driver$/i.test(node.initializer.getText(source))
              ? `presentation:${method}`
              : method
          )
        }
    ts.forEachChild(node, collect)
  }
  collect(source)
  const walk = (node: ts.Node, owner: string) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)
    )
      owner = node.name?.getText(source) ?? owner
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      owner = node.name.getText(source)
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      owner = `${owner}.${node.name.getText(source)}`
    if (ts.isCallExpression(node)) {
      let expression: ts.Expression = node.expression
      while (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression))
        expression = expression.expression
      const raw = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isElementAccessExpression(expression) &&
              ts.isStringLiteral(expression.argumentExpression)
            ? expression.argumentExpression.text
            : undefined
      const resolved = raw ? (aliases.get(raw) ?? raw) : undefined
      const name =
        resolved &&
        ["open", "update", "finish"].includes(resolved) &&
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        /driver$/i.test(expression.expression.getText(source))
          ? `presentation:${resolved}`
          : resolved
      if (name && CONTENT_SINKS.has(name)) {
        const key = `${file} | ${owner} | ${name}`
        const index = (counts.get(key) ?? 0) + 1
        counts.set(key, index)
        sites.push(
          `${key} | ${index}${file === "lib/plugin/core/context.ts" && name === "prepareEgress" ? " | 2C-2-enforced" : ""}`
        )
      }
    }
    ts.forEachChild(node, (child) => walk(child, owner))
  }
  walk(source, "<module>")
  return sites
}

it("requires classification of every sink call site including app and opaque plugin egress", () => {
  const actual = sources()
    .flatMap((file) => callSiteInventory(readFileSync(join(ROOT, file), "utf8"), file))
    .sort()
  expect(actual).toEqual(reviewedSites)
  expect(
    actual.some(
      (site) => site.includes("lib/plugin/core/context.ts") && site.endsWith("2C-2-enforced")
    )
  ).toBe(true)
})

it("detects new sends, aliases, stream patches, edits, planners and shared writers", () => {
  expect(sinkSites("const transmit=adapter.send; transmit(request)")).toBe("send:1")
  expect(sinkSites("const {edit: amend}=adapter; amend(id, payload)")).toBe("edit:1")
  expect(sinkSites("const transmit=adapter.send.bind(adapter); transmit(request)")).toBe("send:1")
  expect(sinkSites("const {update: patch}=driver; patch(ref, snapshot)")).toBe(
    "presentation:update:1"
  )
  expect(sinkSites("adapter.streamReply!(patch); adapter['edit'](id, request)")).toBe(
    "edit:1;streamReply:1"
  )
  expect(
    sinkSites("import {planDelivery as review} from './policy'; review(input); runLarkCli(command)")
  ).toBe("planDelivery:1;runLarkCli:1")
  expect(
    sinkSites(
      "planIntegrationWrite(input);planBrowserSubmission(input);client.appendSessionEvent(event)"
    )
  ).toBe("appendSessionEvent:1;planBrowserSubmission:1;planIntegrationWrite:1")
  expect(sinkSites("buildChatShare(snapshot);client.postSessionRunLiveFrame(frame)")).toBe(
    "buildChatShare:1;postSessionRunLiveFrame:1"
  )
  expect(sinkSites("adapter.react(id, reaction);adapter.typing(target);adapter.delete(id)")).toBe(
    ""
  )
})

const REQUIRED_BOUNDARIES: Record<string, string[]> = {
  "lib/policy/action-review/plan-tool-call.ts": ["enforcePersonalToolCall", "assertPersonalSink"],
  "lib/policy/action-review/plan-integration.ts": ["planIntegrationWrite", "assertPersonalSink"],
  "lib/policy/action-review/plan-browser.ts": ["planBrowserSubmission", "assertPersonalSink"],
  "lib/skills/built-in/dispatcher.ts": ["assertPersonalSink", 'family.startsWith("lark")'],
  "lib/integrations/action-runner.ts": ["assertPersonalSink"],
  "lib/sites/agent-tools.ts": ["assertPersonalSink", "personalSinkContextForRun"],
  "lib/sites/workflow-nodes.ts": ["assertPersonalSink", "execution:workflow:"],
  "lib/workflow/nodes/issues/index.ts": ["assertPersonalSink", "execution:workflow:"],
  "lib/plugin/api/issues-api.ts": ["assertPersonalSink", "pluginExecutionContext"],
  "lib/issues/im/callback-handler.ts": ["assertPersonalSink", "issueProposalSource"],
  "lib/issues/im/propose.ts": ["issueProposalSource", "input.personalContext"],
  "lib/workflow/nodes/data/flow.ts": ["assertPersonalSink"],
  "lib/workflow/apps/result-sharing-service.ts": [
    "assertPersonalSink",
    "bindPersonalShareSnapshot",
  ],
  "lib/scheduler/notification-integration.ts": ["assertPersonalSink"],
  "lib/notifications/runtime.ts": ["checkPersonalSink", "projectLocal"],
  "lib/diagnostics/bus.ts": ["WeakMap", "hostContexts.get", "personalContextForDiagnosticEvent"],
  "components/error/diagnostic-notifier.tsx": ["personalContextForDiagnosticEvent(event)"],
  "lib/connectors/notifications/im-deliver.ts": ["personalContext"],
  "lib/connectors/personal-delivery.ts": ["checkPersonalSink", "resolveConnectorSinkAudience"],
  "lib/connectors/delivery-gateway.ts": ["checkPersonal"],
  "lib/connectors/outbound-runner.ts": ["checkConnectorPersonalSink"],
  "lib/connectors/reply-stream.ts": ["checkConnectorPersonalSink"],
  "lib/connectors/run-presentation/runner.ts": ["checkConnectorPersonalSink"],
  "lib/collab/shared-run-coordinator.ts": [
    "sharedPersonalMessage",
    "readRunPersonalTaint",
    "sharedPersonalReaders",
    "recordPersonalSinkReceipt",
  ],
  "lib/collab/shared-chat-conversion.ts": [
    "projectSharedPersonalMessages",
    "recordPersonalSinkReceipt",
  ],
  "lib/collab/shared-personal-projection.ts": ["withholdForReaders", "samePersonForHost"],
  "lib/share/chat-export.ts": [
    "withholdForReaders",
    "effectivePersonalMarks",
    "recordPersonalSinkReceipt",
    "bindPersonalShareSnapshot",
    "readRunPersonalTaint",
  ],
  "lib/share/client.ts": ["assertPersonalShareSnapshot"],
  "lib/share/personal-snapshot.ts": [
    "WeakMap",
    "assertPersonalShareSnapshot",
    "Host projection proof",
  ],
  "lib/plugin/api/share-api.ts": ["assertPersonalSink", "pluginExecutionContext"],
}

it("retains the personal check at each authoritative Host boundary", () => {
  for (const [file, required] of Object.entries(REQUIRED_BOUNDARIES)) {
    const source = readFileSync(join(ROOT, file), "utf8")
    for (const marker of required)
      expect({ file, source }).toEqual({ file, source: expect.stringContaining(marker) })
  }
})

it("pins native driver mutations and the enclosing function, not just file counts", () => {
  expect(
    callSiteInventory(
      "async function project(){ await driver.update(ref, value); await driver.finish(ref, value) }",
      "lib/example.ts"
    )
  ).toEqual([
    "lib/example.ts | project | presentation:update | 1",
    "lib/example.ts | project | presentation:finish | 1",
  ])
  expect(
    callSiteInventory(
      "const { update: patch } = driver; async function heartbeat(){ patch(ref, value) }",
      "lib/example.ts"
    )
  ).toEqual(["lib/example.ts | heartbeat | presentation:update | 1"])
  expect(
    callSiteInventory(
      "const mutate = driver.finish.bind(driver); function settle(){ mutate(ref, value) }",
      "lib/example.ts"
    )
  ).toEqual(["lib/example.ts | settle | presentation:finish | 1"])
  expect(callSiteInventory("function before(){ fetch(url) }", "app/example.tsx")).not.toEqual(
    callSiteInventory("function after(){ fetch(url) }", "app/example.tsx")
  )
})
