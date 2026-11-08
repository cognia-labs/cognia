/** @jest-environment node */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globSync } from "glob"
import ts from "typescript"

const ROOT = join(__dirname, "..", "..")
// Reviewed producers, CRUD owners and copy-only sinks. A new writer or an
// additional call must be reviewed for Host run binding / mark preservation.
// Shared-chat remains a phase-2C sink; its allowlist is deliberately unchanged.
const REVIEWED_WRITES: Record<string, number> = {
  "components/chat/message-parts/async-questions-card.tsx": 1,
  "components/settings/agent-runtime/sdk-session-manager.tsx": 1,
  "lib/background-tasks/host-delivery-lane.ts": 1,
  "hooks/chat/claude-chat-events.ts": 8,
  "hooks/chat/plan-turn-settle.ts": 1,
  "hooks/chat/router-fusion-chat-turn.ts": 2,
  "lib/chat/steer-runtime.ts": 5,
  "hooks/chat/use-claude-chat-controller.ts": 17,
  "hooks/chat/use-sessions.ts": 2,
  "lib/agent/composition/verified-fresh-agent.ts": 2,
  "lib/squads/gates/record-gate-answer.ts": 1,
  "lib/best-of-n/entry.ts": 1,
  "lib/chat/branch-session.ts": 2,
  "lib/chat/import-handoff-session.ts": 2,
  "lib/chat/phantom-run-runtime.ts": 1,
  "lib/chat/room/runner.ts": 6,
  "lib/chat/shell-job-transcript.ts": 1,
  "lib/chat/video-job-card.ts": 1,
  "lib/chat/working-set.ts": 1,
  "lib/collab/shared-chat-conversion.ts": 1,
  "lib/collab/shared-chat-sync.ts": 7,
  "lib/companion/desktop-write-source.ts": 1,
  "lib/connectors/adapters/lark/message-import.ts": 1,
  "lib/connectors/bus.ts": 3,
  "lib/connectors/inbox-writes/local.ts": 1,
  "lib/connectors/inbox-writes/remote.ts": 1,
  "lib/connectors/runtime.ts": 1,
  "lib/data/import-merge.ts": 1,
  "lib/db/messages.ts": 10,
  "lib/db/outbound-jobs.ts": 1,
  "lib/db/plugin-bridge.ts": 2,
  "lib/dev/expose-test-globals.tsx": 2,
  "lib/headless/person-agent/index.ts": 2,
  "lib/headless/person-agent/runner.ts": 3,
  "lib/integrations/events.ts": 1,
  "lib/plugin/agent-sdk/session.ts": 1,
  "lib/plugin/api/agent-turn.ts": 2,
  "lib/plugin/api/session-seed.ts": 1,
  "lib/router-fusion/api/companion-run-host.ts": 1,
  "lib/router-fusion/db/outbox-appliers.ts": 1,
  "lib/sync/handlers/messages.ts": 1,
  "lib/sync/host-state-service.ts": 3,
  "lib/sync/host-state-store.ts": 3,
  "lib/sync/session-history.ts": 1,
  "lib/voice/live/persist-turns.ts": 1,
  "lib/work-submission/paired-turn-adapter.ts": 1,
  "lib/work-submission/terminal-events.ts": 3,
  "lib/workflow/nodes/sessions/index.ts": 1,
  "lib/workflow/nodes/teams/index.ts": 1,
}

function messageTableWriteCount(text: string): number {
  if (!/\bmessages\b/.test(text)) return 0
  const source = ts.createSourceFile("writer.ts", text, ts.ScriptTarget.Latest, true)
  const aliases = new Set<string>()
  const isMessages = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return aliases.has(node.text)
    if (ts.isPropertyAccessExpression(node))
      return node.name.text === "messages" || isMessages(node.expression)
    if (ts.isCallExpression(node)) return isMessages(node.expression)
    return false
  }
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isMessages(node.initializer)
    )
      aliases.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(source)
  let count = 0
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["add", "put", "bulkAdd", "bulkPut", "update", "bulkUpdate", "modify"].includes(
        node.expression.name.text
      ) &&
      isMessages(node.expression.expression)
    )
      count++
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

it("requires review whenever a message writer is added or gains another write path", () => {
  const actual: Record<string, number> = {}
  for (const file of globSync("{components,hooks,lib,packages,plugins,stores}/**/*.{ts,tsx}", {
    cwd: ROOT,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/__tests__/**",
      "**/.next/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/*.d.ts",
    ],
  }).sort()) {
    const source = readFileSync(join(ROOT, file), "utf8")
    let count =
      messageTableWriteCount(source) +
      [
        ...source.matchAll(
          /\b(?:persistMessages|persistStreamingMessages|commitMessageDelta|toStoredMessageRow|writeMessage)\s*\(/g
        ),
      ].length
    // Track common dependency-injected aliases, including the headless event owner.
    for (const [, alias] of source.matchAll(
      /(?:const|let)\s+(\w+)\s*=\s*[^;\n]*\b(?:persistMessages|persistStreamingMessages|commitMessageDelta|toStoredMessageRow)\b[^;\n]*/g
    )) {
      if (
        ![
          "persistMessages",
          "persistStreamingMessages",
          "commitMessageDelta",
          "toStoredMessageRow",
        ].includes(alias)
      )
        count += [...source.matchAll(new RegExp(`\\b${alias}\\s*\\(`, "g"))].length
    }
    if (count) actual[file] = count
  }
  expect(actual).toEqual(REVIEWED_WRITES)
})

it("keeps every credential success behind the one marking continuation", () => {
  const text = readFileSync(join(ROOT, "lib/execution/personal-credential.ts"), "utf8")
  const source = ts.createSourceFile("gate.ts", text, ts.ScriptTarget.Latest, true)
  const successes: ts.ReturnStatement[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isObjectLiteralExpression(node.expression) &&
      node.expression.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(source) === "ok" &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword
      )
    )
      successes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(successes).toHaveLength(1)
  const continuation = successes[0].parent
  expect(continuation.getText(source).replace(/\s+/g, "")).toContain(
    "awaitmarkPersonalCredential(context,identity,person,credential.source)"
  )
  expect(continuation.getText(source)).toContain('refuse("mark-unavailable", cause)')
})

it("pins each Host producer and every canonical persistence form to marking", () => {
  const seams: Record<string, string[]> = {
    "hooks/chat/claude-chat-events.ts": [
      "bindPersonalMessageChanges(current, appliedMessages",
      "toolCallExecutionRunId(sessionId, frame.turnId, frame.attemptId)",
    ],
    "hooks/chat/use-claude-chat-controller.ts": [
      "bindPersonalMessageRun(assistantId, executionRunId)",
      "bindPersonalMessageRun(userMsg.id, callOptions.backgroundDelivery.personalRunIds)",
    ],
    "lib/plugin/api/agent-turn.ts": ["bindPersonalMessageRun(message.id, entry?.id)"],
    "lib/headless/person-agent/index.ts": [
      "bindPersonalMessageRun(message.id, hostStateRunId(actionId))",
    ],
    "lib/chat/room/runner.ts": [
      "bindPersonalMessageChanges(teamMsgs, nextMessages, ctx?.options.turnId)",
    ],
    "lib/sync/host-state-service.ts": [
      "bindToolCallRun(sessionId, prepared.turnId, receipt.runId)",
    ],
    "lib/background-tasks/result-delivery.ts": [
      "backgroundResultRunIds",
      "map(childJobExecutionRunId)",
    ],
    "lib/background-tasks/host-delivery-lane.ts": [
      "bindPersonalMessageRun(messageId, runIds)",
      'automatedTurnMetadata("background-result")',
    ],
    "lib/claude/adapter.ts": ["remoteDocumentPersonalMarks(manifest)"],
    "lib/connectors/runtime.ts": ["personalMarkVersion: 1"],
    "lib/connectors/inbox-writes/local.ts": ["personalMarkVersion: 1"],
    "lib/connectors/inbox-writes/remote.ts": ["personalMarkVersion: 1"],
    "lib/work-submission/terminal-events.ts": [
      "bindPersonalMessageChanges",
      "toolCallExecutionRunId(event.sessionId, frame.turnId, frame.attemptId)",
    ],
    "lib/db/outbound-jobs.ts": ["personalMarkVersion: 1"],
    "lib/db/plugin-bridge.ts": [
      "const current = await dexie.messages.get(messageId)",
      "preservePersonalMarkMetadata(meta, current.metadata, { rowExists: true })",
    ],
    "lib/companion/desktop-write-source.ts": ["personalMarkVersion: 1"],
  }
  for (const [file, anchors] of Object.entries(seams)) {
    const text = readFileSync(join(ROOT, file), "utf8")
    for (const anchor of anchors)
      expect({
        file,
        present: text.replace(/\s+/g, "").includes(anchor.replace(/\s+/g, "")),
      }).toEqual({ file, present: true })
  }
  const writer = readFileSync(join(ROOT, "lib/db/messages.ts"), "utf8")
  expect([...writer.matchAll(/=\s*personalMessageMetadata\(/g)].length).toBe(4)
  expect(writer).toContain("metadata: stripHoistedMeta(meta)")
})

function missingRowExistence(sourceText: string): string[] {
  const source = ts.createSourceFile("writer.ts", sourceText, ts.ScriptTarget.Latest, true)
  const helpers = new Map([
    ["preservePersonalMarkMetadata", 2],
    ["personalMessageMetadata", 3],
  ])
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const binding of bindings.elements) {
      const index = helpers.get(binding.propertyName?.text ?? binding.name.text)
      if (index !== undefined) helpers.set(binding.name.text, index)
    }
  }
  const violations: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined
      const index = name ? helpers.get(name) : undefined
      if (index !== undefined) {
        const state = node.arguments[index]
        if (
          !state ||
          !ts.isObjectLiteralExpression(state) ||
          !state.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === "rowExists" &&
              property.initializer.getText(source) !== "undefined"
          )
        )
          violations.push(node.getText(source))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

it("requires every metadata-helper caller to explicitly state whether its row exists", () => {
  const violations: Record<string, string[]> = {}
  for (const file of globSync("{components,hooks,lib,packages,plugins,stores}/**/*.{ts,tsx}", {
    cwd: ROOT,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/*.d.ts",
    ],
  })) {
    const text = readFileSync(join(ROOT, file), "utf8")
    if (!/preservePersonalMarkMetadata|personalMessageMetadata/.test(text)) continue
    const missing = missingRowExistence(text)
    if (missing.length) violations[file] = missing
  }
  expect(violations).toEqual({})
})
it("detects omitted row-existence proof even for an aliased helper import", () => {
  const prefix =
    'import { preservePersonalMarkMetadata as preserve } from "@cognia/plugin-contract/types/execution/acting-identity";'
  expect(missingRowExistence(prefix + "preserve(incoming, existing?.metadata)")).toHaveLength(1)
  expect(
    missingRowExistence(
      prefix + "preserve(incoming, existing?.metadata, { rowExists: !!existing })"
    )
  ).toEqual([])
  expect(
    missingRowExistence("personalMessageMetadata(id, incoming, stored?.metadata)")
  ).toHaveLength(1)
  expect(
    missingRowExistence(
      "personalMessageMetadata(id, incoming, stored?.metadata, { rowExists: !!stored })"
    )
  ).toEqual([])
})

it("inventories direct, bulk, aliased and collection metadata mutations", () => {
  expect(
    messageTableWriteCount(
      'db.messages.update(id, { metadata }); db.messages.bulkUpdate(rows); db.messages.where("sessionId").equals(id).modify({ metadata }); const rows = db.messages; rows.update(id, { metadata });'
    )
  ).toBe(4)
  expect(messageTableWriteCount("db.sessions.update(id, { metadata });")).toBe(0)
})
