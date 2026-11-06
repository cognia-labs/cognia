/** @jest-environment node */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globSync } from "glob"
import ts from "typescript"

const ROOT = join(__dirname, "..", "..")

// Owner-outside-dispatch is plugin-held material for phase 5/6. It applies to
// the plugin's own timers/activation/panel UI, never a Host callback. These
// reviewed seams keep a refusing HOST_BACKGROUND binding for runless work.
const HOST_DISPATCH_BINDINGS: Record<string, string[]> = {
  "lib/claude/plugin-hook-ipc.ts": ["withPluginExecutionContext", "HOST_BACKGROUND"],
  "lib/plugin/core/invocation-identity.ts": [
    "HOST_BACKGROUND",
    "localAuthorization",
    "finish(value, release)",
    "dispatching",
  ],
  "lib/plugin/interceptors/dispatch.ts": [
    "registration.pluginId",
    "credentialContext",
    "HOST_BACKGROUND",
  ],
  "packages/plugin-contract/src/lib/plugin/interceptors/dispatch.ts": ["invokeHandler"],
  "lib/plugin/api/issues-api.ts": [
    "withPluginExecutionContext",
    "options.credentialContext",
    "context.credentialContext",
    "HOST_BACKGROUND",
    "input.pullPage!",
    "input.confirmDeparted!",
  ],
  "lib/issues/sync/runtime.ts": [
    "credentialContext = HOST_BACKGROUND",
    "entry.prepare(controller.signal, options.credentialContext)",
  ],
  "lib/issues/sync/providers/github.ts": [
    "admitPersonalCredential",
    "credentialContext",
    "HOST_BACKGROUND",
  ],
  "lib/issues/sync/providers/lark-api.ts": ["withLarkAuthedApi", "credentialContext"],
  "lib/plugin/api/docs-providers-api.ts": [
    "withPluginExecutionContext",
    "options.credentialContext",
    "HOST_BACKGROUND",
  ],
  "lib/plugin/api/sync-api.ts": [
    "bindPluginCallbacks",
    "pluginExecutionContext(pluginId)",
    "driverFor(HOST_BACKGROUND)",
    "entry.driverFor(execution)",
  ],
  "lib/plugin/bridge/sync-bridge.ts": ["driver.fetchPage", "Promise.race", "signal.throwIfAborted"],
  "lib/external-services/sync/runtime.ts": ["entry.factory()", "entry.resolvedTarget"],
  // The paired utility rail is a tool-less model turn; its transport remains
  // behind Host admission and cannot acquire personal tools by a wire label.
  "lib/ai/host-llm-client.ts": ['toolSurface: "none"', "mcpServers: {}", "withHostUtilitySession"],
  "lib/ai/host-utility-session.ts": ["hydrateHostStateSession", "awaitHostStateIntentSettlement"],
  "lib/sync/host-state-service.ts": ['executionRunId: receipt?.runId ?? ""'],
  "lib/data/destinations/registry.ts": [
    "withPluginExecutionContext",
    "pluginDispatchContext",
    "credentialContext",
    "HOST_BACKGROUND",
  ],
  "lib/integrations/providers.ts": [
    "withPluginExecutionContext",
    "credentialContext",
    "HOST_BACKGROUND",
  ],
  "lib/integrations/action-runner.ts": ["withPluginJobExecutionContext"],
  "lib/plugin/auth/connection-manager.ts": [
    "callProvider",
    "pluginDispatchContext",
    "options.credentialContext",
    "admitPersonalCredential",
  ],
  "lib/data/destinations/builtins.ts": ["getBackupDestination(id)", "credentialContext"],
  "lib/data/destinations/google-oauth.ts": [
    "admitPersonalCredential",
    "HOST_BACKGROUND",
    "credentialContext: context",
  ],
  "lib/auth-providers/google/host-auth.ts": [
    "createGoogleDeviceAuthorization",
    "admission",
    "credentialContext",
  ],
  "lib/google-docs/provider.ts": ["credentialContext"],
  "lib/plugin/auth/connect.ts": [
    "withPluginExecutionContext",
    "request.credentialContext",
    "HOST_BACKGROUND",
    "assertRuntimeSupported",
    "credentialContext",
  ],
  "lib/plugin/auth/connections-api.ts": ["pluginExecutionContext(pluginId)", "credentialContext"],
  "lib/plugin/core/context.ts": ["bindPluginContextCallbacks", "execution:workflow:"],
  "lib/plugin/core/manager.ts": [
    "bindPluginCallbacks",
    "this.loader.getModuleExports(pluginId)",
    "pluginDispatchContext",
    '"plugin_python_call"',
  ],
  "lib/plugin/messaging/hooks-system.ts": [
    "bindPluginCallbacks",
    "withPluginCommandExecution",
    "execution ? () => execution : undefined",
  ],
  "lib/claude/adapter-hooks.ts": [
    "execution?: PersonalCredentialContext",
    "dispatchOnMessageReceive",
    "dispatchPostChatReceive",
  ],
  "hooks/chat/use-claude-chat-controller.ts": ["chatHookCredentialContext", "hookExecution"],
  "hooks/chat/claude-chat-events.ts": ["toolCallExecutionRunId", "hookCredentialContext"],
  "lib/identity/forget-profile-identity.ts": ["credentialContext", "forgetProfileAuthSecrets"],
  "stores/account/account-store.ts": ["options.credentialContext", "credentialContext"],
  "components/account/manage/account-danger-tab.tsx": ["localAuthorization: LOCAL_PERSON_RUN"],
  "lib/slash-commands/registry.ts": ["withPluginExecutionContext"],
  "lib/scheduler/executors/plugin-executor.ts": [
    "withPluginExecutionContext",
    'executionRunId: ""',
  ],
  "lib/plugin/api/glance-api.ts": ["bindPluginCallbacks"],
  "lib/decisions/run-decision.ts": ["withPluginExecutionContext", "HOST_BACKGROUND"],
  "lib/plugin/messaging/ipc.ts": [
    "withPluginExecutionContext",
    "const execution = pluginExecutionContext(callerId) ?? HOST_BACKGROUND",
    "HOST_BACKGROUND",
  ],
  "lib/plugin/messaging/message-bus.ts": [
    "withPluginExecutionContext",
    "this.executions.get(event)",
    "HOST_BACKGROUND",
  ],
  "lib/plugin/library/modules.ts": [
    "bindPluginCallbacks",
    "pluginExecutionContext(consumerId)",
    "importBoundModule",
    "HOST_BACKGROUND",
  ],
  "lib/bot/runtime/executors/handler.ts": [
    "withPluginExecutionContext",
    "executionRunId: ctx.runId",
  ],
  "lib/bot/control-writes/lifecycle-hooks.ts": ["withPluginExecutionContext", "HOST_BACKGROUND"],
  "lib/plugin/core/vscode-loader.ts": [
    "withPluginExecutionContext",
    'method === "extension:call"',
    "pluginDispatchContext",
  ],
  "lib/plugin/core/wasm-loader.ts": [
    "withPluginExecutionContext",
    "pluginDispatchContext",
    'command === "plugin_wasm_call"',
  ],
  "lib/plugin/bridge/_shared/python-backed-proxy.ts": [
    "withPluginExecutionContext",
    "pluginDispatchContext",
    "bindPluginCallbacks(options.pluginId, proxy)",
  ],
  "lib/plugin/dexie/migration-runner.ts": [
    "bindPluginCallbacks(pluginId, handler",
    "HOST_BACKGROUND",
  ],
  "lib/plugin/bridge/workflow-integration.ts": ["withPluginExecutionContext", "HOST_BACKGROUND"],
}

it("pins the Host callback inventory, including runless background and the phase 5/6 residual", () => {
  for (const [file, fences] of Object.entries(HOST_DISPATCH_BINDINGS)) {
    const source = readFileSync(join(ROOT, file), "utf8").replace(/\s/g, "")
    for (const fence of fences)
      expect({ file, present: source.includes(fence.replace(/\s/g, "")) }).toEqual({
        file,
        present: true,
      })
  }
})
const ENTRIES = new Set([
  "getCredentials",
  "resolveRequestCredential",
  "getUserAccessToken",
  "googleState",
  "listGoogleConnections",
  "registerHostAuthProviderService",
  "createPluginCredentialAccess",
  "mcpOAuthLoadEntry",
  "mcpOAuthRefresh",
  "resolveMcpRuntimeCredential",
  "resolveGithubReadToken",
  "githubReadAccountsFor",
  "resolveGithubReadTokenForRepo",
  "ghCliToken",
  "verifyLarkImOwnerAuthorization",
  "withUserTokenRefresh",
  "refreshUserToken",
  "connectorsLarkUserAuth",
  "getCredentialsForBotBinding",
  "getGithubBackupToken",
  "loadGoogleDriveTokens",
  "getGoogleDriveAccessToken",
  "refreshGoogleDriveTokens",
  "getGoogleDriveCredentialLease",
  "createGoogleDeviceAuthorization",
  "uploadSnapshotToGoogleDrive",
  "listGoogleDriveSnapshots",
  "downloadGoogleDriveSnapshot",
  "forgetProfileAuthSecrets",
  "getHostAuthSession",
  "listLarkConnections",
])
const ALIAS_TARGETS = new Set([...ENTRIES, "getSessions", "connectorsKeyringGet", "safeKeyringGet"])

function resolutions(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string>()
  const nameOf = (node: ts.Node): string | undefined =>
    ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      ? nameOf(node.expression)
      : ts.isBinaryExpression(node) &&
          [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
            node.operatorToken.kind
          )
        ? (nameOf(node.right) ?? nameOf(node.left))
        : ts.isIdentifier(node)
          ? (aliases.get(node.text) ?? node.text)
          : ts.isPropertyAccessExpression(node)
            ? (aliases.get(node.name.text) ?? node.name.text)
            : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
              ? (aliases.get(node.argumentExpression.text) ?? node.argumentExpression.text)
              : undefined
  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node))
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.propertyName)
      aliases.set(node.name.text, node.propertyName.getText(ast).replaceAll('"', ""))
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer
      const name = nameOf(ts.isBinaryExpression(initializer) ? initializer.right : initializer)
      if (name && ALIAS_TARGETS.has(name)) aliases.set(node.name.text, name)
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const name = nameOf(node.right)
      if (name && ALIAS_TARGETS.has(name)) aliases.set(node.left.text, name)
    }
    if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.initializer)
      if (name && ALIAS_TARGETS.has(name))
        aliases.set(node.name.getText(ast).replaceAll('"', ""), name)
    }
    ts.forEachChild(node, collect)
  }
  collect(ast)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression)
      if (name && ENTRIES.has(name)) found.push(name)
      if (
        name === "authenticatedRequest" &&
        node.arguments.some(
          (argument) =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) && property.name.getText(ast) === "connectionRef"
            )
        )
      )
        found.push("connection-ref-authenticated-request")
      if (name === "getSessions" && source.includes("auth-provider-registry"))
        found.push("auth-provider-sessions")
      if (
        name === "load" &&
        node.arguments.some(
          (arg) =>
            (ts.isIdentifier(arg) &&
              ["GITHUB_TOKEN_KEY", "GOOGLE_DRIVE_TOKENS_KEY"].includes(arg.text)) ||
            (ts.isStringLiteral(arg) && ["github-token", "google-drive-tokens"].includes(arg.text))
        )
      )
        found.push("backup-keyring-user-token")
      if (node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text === "auth:exchange"))
        found.push("service-auth-exchange")
      if (
        name === "call" &&
        node.arguments.some(
          (arg) =>
            ts.isStringLiteral(arg) &&
            ["mcp_oauth_load_entry", "mcp_oauth_refresh"].includes(arg.text)
        )
      )
        found.push("native-mcp-oauth")
      if (
        ["connectorsKeyringGet", "safeKeyringGet"].includes(name ?? "") &&
        node.arguments.some(
          (arg) => ts.isStringLiteral(arg) && ["user_token", "userToken"].includes(arg.text)
        )
      )
        found.push("keyring-user-token")
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node)) &&
      /\bgh\s+auth\s+token\b/.test(node.text)
    )
      found.push("gh-auth-token")
    // Native wrappers (including invoke/call aliases) can return the same raw
    // token pair as the typed helper. A command string is an exit to review.
    if (ts.isStringLiteral(node) && node.text === "connectors_google_docs_auth")
      found.push("native-google-user-auth")
    if (ts.isStringLiteral(node) && node.text === "connectors_lark_user_auth")
      found.push("native-lark-user-auth")
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found.sort()
}

// Exact reviewed resolution sites, not a directory exemption: adding even one
// call in an existing gated file fails. Low-level refresh/adapter helpers are
// reachable only behind the admitted owner; connector ambient probes refuse.
const REVIEWED: Record<string, string[]> = {
  "lib/ai/agent/external/runtimes/acp/acp-dynamic-mcp-controller.ts": [
    "resolveMcpRuntimeCredential",
  ],
  "lib/ai/agent/team/pr-feedback/resolvers.ts": [
    "gh-auth-token",
    "gh-auth-token",
    "ghCliToken",
    "resolveGithubReadToken",
    "resolveGithubReadTokenForRepo",
  ],
  "lib/connectors/adapter-registry.ts": ["keyring-user-token", "keyring-user-token"],
  "lib/auth-providers/feishu/auth-retry.ts": ["connectorsLarkUserAuth", "refreshUserToken"],
  "lib/auth-providers/feishu/authed-api.ts": [
    "connectorsLarkUserAuth",
    "getCredentials",
    "withUserTokenRefresh",
  ],
  "lib/connectors/adapters/lark/http.ts": ["withUserTokenRefresh"],
  "lib/connectors/adapters/lark/index.ts": [
    "connectorsLarkUserAuth",
    "getUserAccessToken",
    "getUserAccessToken",
    "getUserAccessToken",
    "withUserTokenRefresh",
    "withUserTokenRefresh",
    "withUserTokenRefresh",
  ],
  // Admitted token/epoch checks and refresh; OAuth begin/callback are the
  // person's explicit account-setup protocol. The native wrapper is an exit,
  // not an exemption for additional callers.
  "lib/connectors/tauri/commands.ts": ["native-lark-user-auth"],
  "lib/auth-providers/feishu/auth.ts": Array<string>(4).fill("connectorsLarkUserAuth"),
  "lib/auth-providers/feishu/oauth-begin.ts": ["connectorsLarkUserAuth"],
  "lib/auth-providers/feishu/oauth-handler.ts": [
    "connectorsLarkUserAuth",
    "connectorsLarkUserAuth",
    "connectorsLarkUserAuth",
  ],
  // The driver releases user OAuth only with the manager's opaque, per-request
  // authorization. Metadata/epoch reconciliation and disconnect remain internal;
  // legacy user_info hydration separately calls admitPersonalCredential.
  "lib/auth-providers/feishu/host-auth.ts": [
    ...Array<string>(6).fill("connectorsLarkUserAuth"),
    "refreshUserToken",
    "registerHostAuthProviderService",
  ],
  "lib/skills/built-in/lark/acting-identity.ts": [
    "connectorsLarkUserAuth",
    "connectorsLarkUserAuth",
  ],
  "lib/skills/built-in/lark/auth-bridge.ts": ["connectorsLarkUserAuth", "getCredentials"],
  "lib/google-docs/provider.ts": ["getCredentials", "listGoogleConnections"],
  "lib/auth-providers/google/host-auth.ts": [
    "createGoogleDeviceAuthorization",
    ...Array<string>(8).fill("googleState"),
    "registerHostAuthProviderService",
  ],
  "lib/google-docs/auth.ts": ["googleState", "googleState", "googleState", "googleState"],
  "lib/google-docs/config.ts": ["googleState", "googleState", "googleState"],
  "lib/google-docs/oauth-pending.ts": ["googleState", "googleState"],
  "lib/auth-providers/google/state.ts": ["native-google-user-auth"],
  "components/settings/connections/docs-providers/docs-providers-card.tsx": [
    "googleState",
    "listGoogleConnections",
  ],
  "components/settings/data/google-drive-backup-card.tsx": [
    "createGoogleDeviceAuthorization",
    "googleState",
    "googleState",
    "googleState",
    "listGoogleConnections",
  ],
  "plugins/feishu-calendar/src/index.ts": ["connection-ref-authenticated-request"],
  "plugins/feishu-calendar/src/connection.ts": ["connection-ref-authenticated-request"],
  "lib/execution/personal-credential.ts": [
    "verifyLarkImOwnerAuthorization",
    "verifyLarkImOwnerAuthorization",
  ],
  // Auth connection credentials are exposed only by the admitted Host request
  // and builtin Issue Loop; the manager's legacy adapter inherits that decision.
  "lib/integrations/action-runner.ts": [
    "auth-provider-sessions",
    "createPluginCredentialAccess",
    "getCredentials",
    "getCredentialsForBotBinding",
    "resolveRequestCredential",
  ],
  "lib/plugin/auth/connection-manager.ts": [
    "auth-provider-sessions",
    "getCredentials",
    "getCredentials",
    "resolveRequestCredential",
  ],
  "lib/plugin/api/auth-api.ts": [
    "auth-provider-sessions",
    "createPluginCredentialAccess",
    "createPluginCredentialAccess",
    "createPluginCredentialAccess",
    "getCredentials",
    "getHostAuthSession",
    "service-auth-exchange",
  ],
  "components/integrations/integrations-hub.tsx": ["getHostAuthSession"],
  "hooks/external-services/use-auth-connections.ts": [
    "listGoogleConnections",
    "listLarkConnections",
  ],
  "lib/lark-docs/provider.ts": ["listLarkConnections"],
  "lib/integrations/github-issue-loop.ts": ["auth-provider-sessions", "resolveRequestCredential"],
  // Settings is the person's Host UI. VS Code's raw session surface inherits
  // the Host-managed adapter's default refusal; plugin-held legacy sessions
  // remain the phase 5/6 boundary described below.
  "components/settings/data/github-backup-card.tsx": [
    "auth-provider-sessions",
    "getGithubBackupToken",
  ],
  "lib/plugin/vscode-shim/runtime-handlers.ts": ["auth-provider-sessions"],
  "lib/integrations/github-read-credential.ts": [
    "githubReadAccountsFor",
    "resolveRequestCredential",
  ],
  // Host account setup exchanges an explicit one-shot operator SecretRef.
  // Repository webhook settings pass the opaque Host UI proof; backup PAT
  // hooks require admission, while Host GitHub App installation hooks stay service.
  "lib/integrations/github-account-setup.ts": ["resolveRequestCredential"],
  "lib/integrations/github-repo-webhook.ts": ["resolveRequestCredential"],
  // PAT/keyring and Drive OAuth reads require invocation admission. Only the
  // verified Host github-app installation hook stays service.
  "lib/data/destinations/config.ts": [
    "auth-provider-sessions",
    "backup-keyring-user-token",
    "getCredentials",
    "resolveRequestCredential",
  ],
  "lib/data/destinations/builtins.ts": [
    "downloadGoogleDriveSnapshot",
    "getGithubBackupToken",
    "googleState",
    "listGoogleDriveSnapshots",
    "uploadSnapshotToGoogleDrive",
  ],
  "lib/data/destinations/github.ts": ["getGithubBackupToken", "getGithubBackupToken"],
  "lib/data/destinations/google-drive.ts": ["getGoogleDriveCredentialLease"],
  "lib/data/destinations/google-oauth.ts": [
    "getCredentials",
    "listGoogleConnections",
    "listGoogleConnections",
  ],
  "lib/issues/github-writeback.ts": ["githubReadAccountsFor"],
  "lib/issues/sync/providers/github.ts": ["ghCliToken", "githubReadAccountsFor"],
  "lib/identity/forget-profile-identity.ts": [
    "forgetProfileAuthSecrets",
    "forgetProfileAuthSecrets",
  ],
  "lib/mcp/apps-runtime.ts": ["resolveMcpRuntimeCredential"],
  "lib/mcp/credential-resolver.ts": ["mcpOAuthLoadEntry", "mcpOAuthRefresh", "mcpOAuthRefresh"],
  "lib/mcp/invoke.ts": ["resolveMcpRuntimeCredential"],
  "lib/mcp/oauth-tauri.ts": ["mcpOAuthLoadEntry", "native-mcp-oauth", "native-mcp-oauth"],
  "lib/mcp/run-server-map.ts": ["resolveMcpRuntimeCredential"],
  "lib/review/github-runtime.ts": ["resolveGithubReadTokenForRepo"],
}

const NON_PERSONAL_EXITS = {
  "service-auth-exchange": {
    file: "lib/plugin/api/auth-api.ts",
    reason:
      "auth:exchange receives the plugin-held authorization code/refresh token in params; the Host injects only the plugin's configured client secret (service). Plugin-held user token material belongs to ADR-0243 phase 5/6.",
  },
  createPluginCredentialAccess: {
    file: "lib/plugin/api/auth-api.ts",
    reason:
      "Provider owners reading their own Host-managed sessions outside a Host-bound run are plugin-held token material, governed in phase 5/6; inside a run the Host-bound invocation must pass admitPersonalCredential.",
  },
} as const

it("records auth:exchange as a reviewed service exit, not a stored personal token read", () => {
  for (const [exit, entry] of Object.entries(NON_PERSONAL_EXITS)) {
    expect(REVIEWED[entry.file]).toContain(exit)
    expect(resolutions(entry.file, readFileSync(join(ROOT, entry.file), "utf8"))).toContain(exit)
    expect(entry.reason).toContain("phase 5/6")
  }
})

function violations(inventory: Record<string, string[]>): string[] {
  return Object.entries(inventory).flatMap(([file, calls]) =>
    JSON.stringify(calls) === JSON.stringify(REVIEWED[file]) ? [] : [`${file}: ${calls.join(", ")}`]
  )
}

it("enumerates every personal credential resolution point under Host source", () => {
  const inventory = Object.fromEntries(
    globSync(
      "{lib,hooks,components,stores,packages/plugin-contract/src,plugins/feishu-calendar/src}/**/*.{ts,tsx}",
      {
        cwd: ROOT,
        ignore: ["**/*.test.*", "**/testing/**", "**/__tests__/**"],
      }
    )
      .map((file) => [file, resolutions(file, readFileSync(join(ROOT, file), "utf8"))] as const)
      .filter(([, calls]) => calls.length)
  )
  expect(violations(inventory)).toEqual([])
  expect(Object.keys(REVIEWED).filter((file) => !inventory[file])).toEqual([])
})

it("catches new ungated calls, aliases, properties and keyring/CLI fallback in reviewed files", () => {
  const cases = resolutions(
    "lib/new.ts",
    `
    import { mcpOAuthLoadEntry as load } from "./oauth"
    const read = load
    read("personal"); api.getUserAccessToken("owner")
    provider.resolveRequestCredential("personal"); manager.getCredentials("personal")
    api["googleState"]({ action: "accessToken", lineageId: "personal" })
    connectorsKeyringGet("owner", "user_token")
    safeKeyringGet("owner", "user_token")
    const keyringRead = connectorsKeyringGet
    keyringRead("owner", "user_token")
    runHeadlessExec({ command: "gh auth token" })
    // getUserAccessToken("comment")
  `
  )
  expect(cases).toEqual(
    [
      "getCredentials",
      "resolveRequestCredential",
      "getUserAccessToken",
      "gh-auth-token",
      "keyring-user-token",
      "keyring-user-token",
      "keyring-user-token",
      "googleState",
      "mcpOAuthLoadEntry",
    ].sort()
  )
  expect(violations({ "lib/new.ts": cases })).toHaveLength(1)
  const [file, approved] = Object.entries(REVIEWED)[0]
  expect(violations({ [file]: [...approved, "getUserAccessToken"].sort() })).toHaveLength(1)
})

it("catches Lark snapshot tokens through typed, property, alias and native exits", () => {
  const cases = resolutions(
    "lib/bypass.ts",
    `
    import { connectorsLarkUserAuth as snapshot } from "./commands"
    const read = snapshot
    let assigned
    assigned = snapshot
    const { connectorsLarkUserAuth: destructured } = api
    const deps = { userAuth: snapshot }
    async function bypass() {
      const direct = await connectorsLarkUserAuth({ action: "snapshot", adapterId: "a" })
      await read({ action: "snapshot", adapterId: "a" })
      await assigned({ action: "snapshot", adapterId: "a" })
      await destructured({ action: "snapshot", adapterId: "a" })
      await deps.userAuth({ action: "snapshot", adapterId: "a" })
      await api["connectorsLarkUserAuth"]({ action: "snapshot", adapterId: "a" })
      await native.invoke("connectors_lark_user_auth", { input: { action: "snapshot" } })
      const cmd = "connectors_lark_user_auth"
      await invokeAlias(cmd, { input: { action: "snapshot" } })
      return direct.accessToken
    }
  `
  )
  expect(cases).toEqual(
    [
      ...Array<string>(6).fill("connectorsLarkUserAuth"),
      "native-lark-user-auth",
      "native-lark-user-auth",
    ].sort()
  )
  expect(violations({ "lib/bypass.ts": cases })).toHaveLength(1)
})

it("catches new Host connection, session and backup credential exits through aliases", () => {
  const calls = resolutions(
    "lib/new-exits.ts",
    `
      import { getSessions as sessions } from "./auth-provider-registry"
      import { getHostAuthSession as hostSession } from "./auth-api"
      const backupToken = getGithubBackupToken
      const driver = { read: manager.getCredentialsForBotBinding }
      sessions("provider"); hostSession("provider", []); backupToken("pat")
      driver.read("connection", "bot", binding)
      api["loadGoogleDriveTokens"](); refreshGoogleDriveTokens("refresh")
      getGoogleDriveAccessToken()
      const discover = listLarkConnections
      discover()
      backupDestinationSecrets().load(GITHUB_TOKEN_KEY)
      keyring.load("google-drive-tokens")
      const lease = api.getGoogleDriveCredentialLease
      lease(); api["createGoogleDeviceAuthorization"](attempt);
      (deps.forgetAuthSecrets ?? forgetProfileAuthSecrets)("profile");
      (await import("./google-drive")).listGoogleDriveSnapshots();
      (await import("./google-drive")).downloadGoogleDriveSnapshot("id");
      (await import("./google-drive")).uploadSnapshotToGoogleDrive("data", meta);
    `
  )
  expect(calls).toEqual(
    [
      "auth-provider-sessions",
      "getHostAuthSession",
      "getGithubBackupToken",
      "getCredentialsForBotBinding",
      "loadGoogleDriveTokens",
      "refreshGoogleDriveTokens",
      "getGoogleDriveAccessToken",
      "listLarkConnections",
      "backup-keyring-user-token",
      "backup-keyring-user-token",
      "getGoogleDriveCredentialLease",
      "createGoogleDeviceAuthorization",
      "forgetProfileAuthSecrets",
      "listGoogleDriveSnapshots",
      "downloadGoogleDriveSnapshot",
      "uploadSnapshotToGoogleDrive",
    ].sort()
  )
  expect(violations({ "lib/new-exits.ts": calls })).toHaveLength(1)
})

it("catches Google token/snapshot aliases, Host auth service registrations and connectionRef requests", () => {
  const calls = resolutions(
    "lib/google-bypass.ts",
    `
    import { googleState as state } from "./state"
    const read = state
    read({ action: "snapshot" }); state({ action: "accessToken", lineageId: "a" })
    native.invoke("connectors_google_docs_auth", { input: { action: "accessToken" } })
    registerHostAuthProviderService("google", "auth.google", "1.0.0")
    context.authenticatedRequest(url, { connectionRef: ref })
  `
  )
  expect(calls).toEqual(
    [
      "googleState",
      "googleState",
      "native-google-user-auth",
      "registerHostAuthProviderService",
      "connection-ref-authenticated-request",
    ].sort()
  )
  expect(violations({ "lib/google-bypass.ts": calls })).toHaveLength(1)
})
