/**
 * Kimi Code CLI: subscription login through a terminal auth method, every
 * permission mode, model/thinking selectors, stdio/HTTP/SSE MCP across fork
 * and deferred (GUI) fork, close/resume, and the native session index.
 * `--live` adds native tools, image and resource input, Shell, questions,
 * denial, dontAsk, compaction and in-flight cancellation on the real login.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { waitUntilUnlisted, type VendorSmoke } from "../generic"
import { check, ownSession, runTurn, type AcpAdapter, type SmokeContext } from "../kit"
import { startMcpProbes, type McpProbes } from "../mcp-probes"

// Fixed 64x64 red PNG: the model must receive the image, not a text marker.
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC"

const BASE_ENV = {
  KIMI_DISABLE_TELEMETRY: "1",
  KIMI_LOOP_MAX_STEPS_PER_TURN: "12",
  KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: "2",
  // An explicit empty model override prevents accidental shell BYOK use.
  KIMI_MODEL_NAME: "",
  KIMI_MODEL_API_KEY: "",
}

function kimiHome(context: SmokeContext): string {
  return context.live
    ? path.resolve(process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code"))
    : path.join(context.scratch, "kimi-state")
}

async function waitForMcp(adapter: AcpAdapter, sessionId: string, probes: McpProbes) {
  let listing = ""
  for (let attempt = 0; attempt < 30; attempt++) {
    listing = (await runTurn(adapter, sessionId, "/mcp")).reply
    if (
      probes.servers.every((server) =>
        new RegExp(`${server.name} .*connected.*1 tools`).test(listing)
      )
    )
      return listing
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Session lost MCP tools: ${listing}`)
}

async function liveTurns(
  context: SmokeContext,
  adapter: AcpAdapter,
  sessionId: string,
  probes: McpProbes,
  mcpServers: McpProbes["servers"]
): Promise<Record<string, unknown>> {
  const { scratch } = context
  const summaries: Record<string, unknown> = {}
  const tools = await runTurn(
    adapter,
    sessionId,
    `Call the MCP kimi-probe probe tool once. Write exactly its returned marker to the relative file result.txt in the current working directory, then read that file to verify it. Do not access other directories, use network, or run unrelated commands. Report the verified marker.`,
    { allowPermissions: true }
  )
  check(
    fs.readFileSync(probes.stdioReceipt, "utf8") === probes.stdioMarker,
    "Native MCP tool was not called"
  )
  check(
    fs.readFileSync(path.join(scratch, "result.txt"), "utf8").trim() === probes.stdioMarker,
    "Native file edit failed"
  )
  check((tools.events.permission_request ?? 0) > 0, "Native manual approval was not exercised")
  check(tools.stopReason === "end_turn", "Tool turn did not finish")
  summaries.tools = tools

  const image = await runTurn(
    adapter,
    sessionId,
    "Do not use tools. What solid color is the attached image? Reply with only the lowercase English color.",
    {
      content: [
        { type: "image", source: { type: "base64", data: RED_PNG, mediaType: "image/png" } },
      ],
    }
  )
  check(image.reply.trim().toLowerCase() === "red", `Image understanding failed: ${image.reply}`)
  summaries.image = image

  const resourceMarker = `RESOURCE_${randomUUID()}`
  const resource = await runTurn(
    adapter,
    sessionId,
    "Do not use tools. Reply with exactly the text in the attached text resource.",
    {
      content: [
        {
          type: "resource",
          resource: {
            uri: "cognia-probe://resource",
            mimeType: "text/plain",
            text: resourceMarker,
          },
        },
      ],
    }
  )
  check(resource.reply.trim() === resourceMarker, "Embedded text resource was lost")
  summaries.resource = resource

  const shellMarker = `SHELL_${randomUUID()}`
  summaries.shell = await runTurn(
    adapter,
    sessionId,
    `Use the Shell tool once to execute exactly this command:\nprintf '%s' '${shellMarker}' > shell-result.txt\nThen reply with ${shellMarker}. Do not use file editing tools, access other directories or run any other command.`,
    { allowPermissions: true }
  )
  check(
    fs.readFileSync(path.join(scratch, "shell-result.txt"), "utf8") === shellMarker,
    "Native Shell execution failed"
  )

  const question = await runTurn(
    adapter,
    sessionId,
    "Use AskUserQuestion now to ask two questions: one single choice (Tests or Docs), one multiple choice (Alpha or Beta). Wait for both answers, then reply with the selected labels. Do not use other tools.",
    { allowPermissions: true }
  )
  check((question.events.elicitation_request ?? 0) > 0, "Native question form was not exercised")
  summaries.question = question

  const denySession = await adapter.createSession({ cwd: scratch, mcpServers })
  ownSession(context, adapter, denySession.id)
  fs.rmSync(probes.stdioReceipt, { force: true })
  const deniedPrompt =
    "Call the kimi-probe MCP probe tool once. If permission is denied, stop immediately without retrying or using other tools."
  const denied = await runTurn(adapter, denySession.id, deniedPrompt)
  check((denied.events.permission_request ?? 0) > 0, "Native denial was not exercised")
  check(!fs.existsSync(probes.stdioReceipt), "Denied MCP tool still executed")
  summaries.denial = denied
  await adapter.setSessionMode(denySession.id, "dontAsk")
  const silentDenial = await runTurn(adapter, denySession.id, deniedPrompt)
  check(
    (silentDenial.events.permission_request ?? 0) === 0,
    "dontAsk surfaced a permission question"
  )
  check(!fs.existsSync(probes.stdioReceipt), "dontAsk executed an unallowlisted MCP tool")
  summaries.dontAsk = silentDenial
  await adapter.deleteSession(denySession.id)

  const compact = await runTurn(adapter, sessionId, "/compact", { allowPermissions: true })
  check(compact.stopReason === "end_turn", "Native compaction trigger was not acknowledged")
  check(!/unknown|failed|error/i.test(compact.reply), `Compaction failed: ${compact.reply}`)
  summaries.compaction = compact

  summaries.inFlightCancellation = await cancelRunningShell(context, adapter, mcpServers)
  return summaries
}

async function cancelRunningShell(
  context: SmokeContext,
  adapter: AcpAdapter,
  mcpServers: McpProbes["servers"]
) {
  const { scratch } = context
  const cancelSession = await adapter.createSession({ cwd: scratch, mcpServers })
  ownSession(context, adapter, cancelSession.id)
  let cancelled = false
  let stopReason: string | undefined
  let stopPolling = false
  const cancellation = (async () => {
    const deadline = Date.now() + 60_000
    while (!stopPolling && Date.now() < deadline) {
      if (fs.existsSync(path.join(scratch, "cancel-started.txt"))) {
        await adapter.cancel(cancelSession.id)
        cancelled = true
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })()
  try {
    const turn = await runTurn(
      adapter,
      cancelSession.id,
      "Use Shell once to run exactly: printf started > cancel-started.txt; sleep 30; printf finished > cancel-finished.txt. Do not use other tools or change other files.",
      { allowPermissions: true, timeout: 90_000 }
    )
    stopReason = turn.stopReason
  } finally {
    stopPolling = true
    await cancellation
  }
  check(cancelled, "No running Shell tool was cancelled")
  check(stopReason === "cancelled", `Cancellation stop reason: ${stopReason}`)
  check(!fs.existsSync(path.join(scratch, "cancel-finished.txt")), "Cancelled Shell still finished")
  await adapter.deleteSession(cancelSession.id)
  return { stopReason, toolStarted: true, toolFinished: false }
}

export const kimi: VendorSmoke = {
  runtimeId: "kimi",
  agentName: "Kimi Code CLI",
  isolateHome: false,
  isolatedEnv: (context) => ({ ...BASE_ENV, KIMI_CODE_HOME: kimiHome(context) }),
  liveEnv: (context) => ({ ...BASE_ENV, KIMI_CODE_HOME: kimiHome(context) }),
  async run(context, { adapter, config, init }) {
    const { scratch } = context
    const state = kimiHome(context)
    const auth = adapter.getAuthMethods().find((method) => method.id === "login")
    check(auth?.type === "terminal", "Kimi terminal subscription login missing")
    check(auth.env?.KIMI_CODE_HOME === state, "Login does not target the selected CLI state")
    check(init.agentCapabilities?.loadSession, "Session load missing")
    check(init.agentCapabilities?.promptCapabilities?.image, "Image support missing")
    check(init.agentCapabilities?.mcpCapabilities?.http, "HTTP MCP support missing")
    const summaries: Record<string, unknown> = {}

    if (!context.live) {
      await adapter.disconnect()
      // Synthetic credentials exercise native config/lifecycle, never a model request.
      Object.assign(config.process!.env!, {
        KIMI_MODEL_NAME: "fixture",
        KIMI_MODEL_PROVIDER_TYPE: "openai",
        KIMI_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
        KIMI_MODEL_API_KEY: "synthetic-fixture",
      })
      await adapter.connect(config)
    }

    const probes = await startMcpProbes(context, "kimi")
    const mcpServers = probes.servers
    const session = await adapter.createSession({ cwd: scratch, mcpServers })
    ownSession(context, adapter, session.id)
    for (const mode of [
      "plan",
      "acceptEdits",
      "dontAsk",
      "bypassPermissions",
      "default",
    ] as const) {
      await adapter.setSessionMode(session.id, mode)
      check(adapter.getSession(session.id)?.permissionMode === mode, `Mode failed: ${mode}`)
    }
    const options = adapter.getConfigOptions(session.id)
    const model = options?.find((option) => option.id === "model")
    check(model, "Model selector missing")
    await adapter.setConfigOption(session.id, model.id, model.currentValue)
    const thinking = options?.find((option) => option.id === "thinking")
    check(thinking, "Thinking selector missing")
    await adapter.setConfigOption(session.id, thinking.id, thinking.currentValue)
    summaries.configOptions = options?.map((option) => ({ id: option.id, type: option.type }))
    summaries.modes = true

    if (context.live)
      Object.assign(summaries, await liveTurns(context, adapter, session.id, probes, mcpServers))

    check(
      (await adapter.listSessions({ cwd: scratch })).some(
        (entry) => entry.sessionId === session.id
      ),
      "Saved session missing"
    )
    const fork = await adapter.forkSession(session.id, { cwd: scratch, mcpServers })
    ownSession(context, adapter, fork.id)
    summaries.forkMcp = await waitForMcp(adapter, fork.id, probes)
    if (context.live) {
      fs.rmSync(probes.stdioReceipt, { force: true })
      const forkTools = await runTurn(
        adapter,
        fork.id,
        "Call the kimi-probe MCP probe tool once and reply with its exact returned marker. Do not use any other tools.",
        { allowPermissions: true }
      )
      check(
        fs.readFileSync(probes.stdioReceipt, "utf8") === probes.stdioMarker,
        "Fork did not call MCP tool"
      )
      check(forkTools.reply.includes(probes.stdioMarker), "Fork did not return tool marker")
      summaries.forkToolCall = forkTools
      const networkTools = await runTurn(
        adapter,
        fork.id,
        "Call both kimi-http-probe and kimi-sse-probe MCP probe tools once each. Reply with both returned markers. Do not use other tools.",
        { allowPermissions: true }
      )
      check(
        probes.networkCalls.has("http") && probes.networkCalls.has("sse"),
        "HTTP/SSE tools were not both called"
      )
      check(
        networkTools.reply.includes(probes.networkMarkers.http) &&
          networkTools.reply.includes(probes.networkMarkers.sse),
        "HTTP/SSE markers missing"
      )
      summaries.httpSseToolCalls = networkTools
    }
    await adapter.closeSession(fork.id)
    await adapter.deleteSession(fork.id)

    const deferredFork = await adapter.forkSession(session.id, { cwd: scratch })
    ownSession(context, adapter, deferredFork.id)
    const prepared = await adapter.prepareForkSessionForExecution(deferredFork.id, {
      cwd: scratch,
      mcpServers,
    })
    check(prepared?.id === deferredFork.id, "GUI fork was not prepared with fresh tool bindings")
    summaries.deferredForkMcp = await waitForMcp(adapter, deferredFork.id, probes)
    await adapter.deleteSession(deferredFork.id)

    await adapter.disconnect()
    await adapter.connect(config)
    await adapter.loadSession(session.id, { cwd: scratch, mcpServers })
    await adapter.closeSession(session.id)
    await adapter.resumeSession(session.id, { cwd: scratch, mcpServers })
    await adapter.deleteSession(session.id)
    // Native 2.1.1 can publish an in-flight pre-delete index scan; wait for it.
    check(
      await waitUntilUnlisted(async () =>
        (await adapter.listSessions({ cwd: scratch })).some(
          (entry) => entry.sessionId === session.id
        )
      ),
      "Deleted probe session still listed after index reconciliation"
    )
    summaries.listForkCloseLoadResumeDelete = true
    return summaries
  },
}
