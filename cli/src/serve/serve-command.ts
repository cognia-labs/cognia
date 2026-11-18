/**
 * `cognia-agent serve` — the headless brain (ADR-0059 W3 / T-B3).
 *
 * Boot order (graceful stop reverses it):
 *
 *   1. env/flags → `__COGNIA_HEADLESS__` marker → fake-indexeddb shim
 *   2. `ensureHeadlessAccount` (registry create-if-missing + activate +
 *      guarded host unlock — `desktop-sync-source` rejects pulls otherwise)
 *   3. durability: the account's SQLite store (`sqlite-v5`, ADR-0059)
 *   4. `setTransport(CompanionTransport)` with an in-memory config provider
 *      (service token, never persisted) — the control plane: `agent_send`
 *      flows brain → RPC → cognia-server → its sidecar
 *   5. `BridgeClient.connect()` + hello — the data plane the three
 *      installers answer on
 *   6. `bootstrapHeadlessRuntimes()` over the registered roster
 *   7. block on SIGINT/SIGTERM
 *
 * The sidecar is spawned by cognia-server (R8), NOT by the brain — no
 * transport conflict, and the WebView↔Tauri isomorphism holds exactly.
 */
import { initializePersonChat } from "@/lib/headless/person-chat"
import os from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"

// `serveCommand` is also imported directly by embedders and tests, bypassing
// the executable entry point. Install IndexedDB synchronously before any
// `@/lib` dependency can construct an eager Dexie singleton (notably the
// scheduler database); the async installer below adds the window/storage shims.
import "../db/install-indexeddb"

import { getExecutionBroker } from "@/lib/execution/broker"
import { getStorageRetentionSnapshot } from "@/lib/storage/retention"
import { bootstrapHeadlessRuntimes, type HeadlessRuntimeStatus } from "@/lib/headless/bootstrap"
import {
  installRemoteWorkerRuntime,
  type RemoteWorkerDescriptor,
} from "@/lib/squads/workers/remote-worker-runtime"
import { WorkerRpcPool } from "@/lib/squads/workers/worker-rpc-pool"
import { clearPartitionArtifactKeyBase } from "@/lib/accounts/partition-artifact-keys"
import { loadMessageResolver } from "@/lib/headless/i18n"
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"
import { setTransport } from "@/lib/tauri"
import { setExtensionHostFileReader } from "@/lib/browser/extension-engine"
import { CompanionTransport, type CompanionConfig } from "@/lib/tauri/transport-companion"

import { brainAccountSyncHost, brainBackup } from "../account-sync/headless-sync"
import type { ParsedArgs } from "../cli/args"
import { stringFlag } from "../cli/args"
import type { OutputSink } from "../cli/output"
import { fsReader, resolveHome, userConfigPath } from "../config/load"
import {
  accountSignInDir,
  describeLocalAccountSource,
  resolveLocalAccount,
} from "../config/local-account"
import {
  describePerson,
  pinBoundPerson,
  readAccountSignIn,
  type LogtoSessionFs,
} from "../config/logto-session"
import { cliConfigFileSchema, collabCliSchema, type CollabCliConfig } from "../config/schema"
import { VERSION } from "../version"
import { ensureHeadlessAccount } from "./account"
import {
  createNodeBackupFilesystem,
  createUnavailableBackupFilesystem,
  getServeInstallationId,
} from "./backup-filesystem"
import { resolveBrainProfile } from "./brain-profile"
import { BridgeClient, type BridgeClientOptions, type WebSocketLike } from "./bridge-client"
import { startHeadlessCollabReader } from "./collab-reader"
import { startDurability } from "./durability"
import { resolveServeHome } from "./persistence/backend"
import { createNodePluginRuntimeAdapter } from "./plugin-runtime-adapter"
import { installRuntimeControl } from "./runtime-control"

export interface ServeDeps {
  out: OutputSink
  env?: NodeJS.ProcessEnv
  /** Injected WS factory for the bridge (tests). */
  wsFactory?: (url: string) => WebSocketLike
  /** Resolves to trigger graceful shutdown (tests; defaults to SIGINT/SIGTERM). */
  shutdown?: Promise<void>
  /** Test hook: runs after the runtimes started, before blocking. */
  onStarted?: () => Promise<void> | void
  proc?: Pick<NodeJS.Process, "on" | "off" | "memoryUsage">
  /** The accounts' sign-in files (tests). */
  sessionFs?: LogtoSessionFs
}

/** The start-up line naming whom the Brain acts for, from the account's sign-in. */
export function actsForLine(
  cliHome: string,
  localAccountId: string,
  sessionFs?: LogtoSessionFs
): string {
  const entry = readAccountSignIn(
    accountSignInDir(cliHome, localAccountId),
    localAccountId,
    sessionFs
  )
  const login = `\`cognia-agent logto login --account ${localAccountId}\``
  if (entry.personError) return `account ${localAccountId} acts for nobody: ${entry.personError}`
  if (!entry.person) return `account ${localAccountId} is not signed in; run ${login}`
  const who = `account ${localAccountId} acts for ${describePerson(entry.person)} at ${entry.person.issuer}`
  return entry.session ? who : `${who} (signed out; run ${login} as this person)`
}

export function resolveServeCollabConfig(
  env: NodeJS.ProcessEnv,
  cliHome: string
): CollabCliConfig | undefined {
  const url = env.COGNIA_COLLAB_URL?.trim()
  const orgId = env.COGNIA_COLLAB_ORG_ID?.trim()
  if (url || orgId) return collabCliSchema.parse({ url, orgId })
  const raw = fsReader(userConfigPath(cliHome))
  if (!raw) return undefined
  return cliConfigFileSchema.parse(JSON.parse(raw)).collab
}

function deriveBridgeUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, "ws").replace(/\/$/, "")}/internal/bridge`
}

export function projectWorkerPlacement(worker: RemoteWorkerDescriptor) {
  const placementReason = !worker.manifest.executionProfile
    ? "execution_profile_missing"
    : !worker.manifest.taskWorkspace.enabled
      ? "task_workspace_unavailable"
      : worker.manifest.workspaceBindingRefs.length === 0
        ? "workspace_missing"
        : undefined
  return {
    hostRef: worker.hostRef,
    usedSlots: worker.activeTurns,
    placementReady: placementReason === undefined,
    ...(placementReason ? { placementReason } : {}),
  }
}

export async function serveCommand(args: ParsedArgs, deps: ServeDeps): Promise<number> {
  const { out } = deps
  const env = deps.env ?? process.env
  const proc = deps.proc ?? process

  // ── Config (canonical env contract; token is env-only, never argv) ────────
  const serverUrl = stringFlag(args, "server-url") ?? env.COGNIA_SERVER_URL
  if (!serverUrl) {
    out.error("serve: missing --server-url / COGNIA_SERVER_URL\n")
    return 2
  }
  const serviceToken = env.COGNIA_SERVICE_TOKEN
  if (!serviceToken) {
    out.error("serve: COGNIA_SERVICE_TOKEN is not set (env-only by design)\n")
    return 2
  }
  const profile = resolveBrainProfile(env)
  if (!profile.ok) {
    out.error(`${profile.error}\n`)
    return 2
  }
  // A member's data partition (plan §9a) serves that member's data commands
  // only: no collaboration reader (it would use the Host's CLI session), no
  // agent workers, no account sync, no plugins.
  const personBrain = profile.host === "person-brain"
  initializePersonChat(profile.host, env)
  if (personBrain) {
    // The CLI entry gave this process its own process table. A member's
    // partition never spawns locally; its agents run in the Host's sandbox
    // pool (P6e) through the person plane its `person-agent` runtime installs.
    const { uninstallCliExternalAgentHost } = await import("../runtime/external/host-branch")
    uninstallCliExternalAgentHost()
  }
  const account = resolveLocalAccount(args, env)
  if (!account.ok) {
    out.error(`serve: ${account.error}\n`)
    return 2
  }
  const localAccountId = account.account.id
  const bridgeUrl = env.COGNIA_BRIDGE_URL ?? deriveBridgeUrl(serverUrl)
  const home = resolveServeHome(env, stringFlag(args, "home"))
  let backupInstallationId: string | undefined
  let backupFailure: Error | undefined
  if (!personBrain) {
    try {
      backupInstallationId = await getServeInstallationId(home)
    } catch (cause) {
      backupFailure = new Error(
        `Host backups unavailable: cannot read or create ${path.join(home, "installation-id")}: ${cause instanceof Error ? cause.message : String(cause)}. Restore a valid installation identity and restart the Host.`
      )
      out.error(`serve: ${backupFailure.message}\n`)
    }
  }

  // ── 1. Headless marker + IndexedDB shim ────────────────────────────────────
  ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
  await installFakeIndexedDb()

  // ── 2. Account ─────────────────────────────────────────────────────────────
  await ensureHeadlessAccount(localAccountId, { partitionArtifactKeys: personBrain })
  out.write(
    `serve: account ${localAccountId} unlocked (from ${describeLocalAccountSource(account.account.source)})\n`
  )
  if (personBrain) out.write("serve: person partition profile (data only)\n")

  // ── 3. Durability ──────────────────────────────────────────────────────────
  const durability = await startDurability({
    home,
    accountId: localAccountId,
    proc,
  })
  out.write(`serve: durability ${durability.backend}\n`)

  // The person this Brain acts for: the account's binding, pinned for the
  // life of the process (`pinBoundPerson`). A member's partition has none: its
  // person comes from the Host's member standing, never the CLI's sign-in.
  const cliHome = resolveHome(env, os.homedir())
  const person = personBrain
    ? () => null
    : pinBoundPerson(accountSignInDir(cliHome, localAccountId), deps.sessionFs)
  if (!personBrain) out.write(`serve: ${actsForLine(cliHome, localAccountId, deps.sessionFs)}\n`)

  // Optional read-only collaboration plane. Credentials are loaded from the
  // account's 0600 Logto session; no bearer token is accepted in env.
  const collabConfig = personBrain ? null : resolveServeCollabConfig(env, cliHome)
  const collabReader = collabConfig
    ? await startHeadlessCollabReader({
        localAccountId,
        cliHome,
        config: collabConfig,
        person,
        env,
      }).catch((cause) => {
        out.error(`serve: collaboration reader failed: ${String(cause)}\n`)
        return null
      })
    : null
  if (collabReader?.rebound) {
    out.write(
      `serve: account ${localAccountId} now acts for ${collabReader.rebound.to} ` +
        `(was ${collabReader.rebound.from}); its collaboration read cursors were reset\n`
    )
  }
  if (collabReader?.status === "active") out.write("serve: collaboration reader active\n")
  if (collabReader?.status === "not-signed-in") {
    out.write(
      "serve: collaboration configured; run " +
        `\`cognia-agent logto login --account ${localAccountId}\` as this account's person, ` +
        "then restart, to activate\n"
    )
  }

  // ── 4. Control plane: CompanionTransport with the service token ───────────
  let currentToken = serviceToken
  const configProvider = (): CompanionConfig => ({
    baseUrl: serverUrl,
    serviceToken: currentToken,
    deviceId: `brain-${localAccountId}`,
    serverVersion: "headless",
  })
  const transport = new CompanionTransport({
    configProvider,
    rpcPath: "/internal/_rpc",
    eventsPath: "/internal/events",
  })
  setTransport(transport)
  setExtensionHostFileReader(async (file) => new Uint8Array(await readFile(file)))

  // ── 5. Data plane: the bridge WS ───────────────────────────────────────────
  const bridgeRef: { current: BridgeClient | null } = { current: null }
  const workerPool = new WorkerRpcPool({
    sendFrame: (connectionId, _frame, finalize) => {
      const frame = finalize()
      if (frame === undefined) return
      if (!bridgeRef.current) throw new Error("brain bridge is not connected")
      bridgeRef.current.sendWorkerFrame(connectionId, frame)
    },
    onWorkersChanged: (workers) => {
      void transport
        .call("fleet_project_worker_load", {
          loads: workers.map(projectWorkerPlacement),
        })
        .catch(() => undefined)
    },
  })
  // Hello advertises runtime-health before bootstrap; publish changes immediately.
  let bootstrapped = false
  let currentRuntimeStatus: HeadlessRuntimeStatus[] = []
  let runtimeStatus: (() => HeadlessRuntimeStatus[]) | null = null
  // A person brain never hosts agent workers; the Host does not route them to it.
  const workerHandlers: Pick<
    BridgeClientOptions,
    "onWorkerAttach" | "onWorkerFrame" | "onWorkerDetach"
  > = personBrain
    ? {}
    : {
        onWorkerAttach: ({ connectionId, hostRef, manifest }) =>
          workerPool.attach({
            connectionId,
            hostRef,
            manifest,
          }),
        onWorkerFrame: (connectionId, frame) => workerPool.receive(connectionId, frame),
        onWorkerDetach: ({ connectionId, reason }) => workerPool.detach(connectionId, reason),
      }
  const bridge = new BridgeClient({
    url: bridgeUrl,
    token: currentToken,
    accountId: localAccountId,
    brainVersion: VERSION,
    wsFactory: deps.wsFactory,
    onTokenRefresh: (token) => {
      currentToken = token
    },
    ...workerHandlers,
    rss: () => durability.rss(),
    // Every agent run and chat turn holds an execution-broker lease.
    activeRuns: () => getExecutionBroker().countRunning(),
    runtimeHealth: () => ({
      bootstrapped,
      failedRequiredRuntimes: (runtimeStatus?.() ?? currentRuntimeStatus)
        .filter((runtime) => runtime.criticality === "required" && runtime.state === "failed")
        .map((runtime) => runtime.name),
      restartingRequiredRuntimes: (runtimeStatus?.() ?? currentRuntimeStatus)
        .filter((runtime) => runtime.criticality === "required" && runtime.state === "restarting")
        .map((runtime) => runtime.name),
    }),
    failedRuntimes: () => {
      const failed = (runtimeStatus?.() ?? currentRuntimeStatus)
        .filter((runtime) => runtime.state === "failed")
        .map((runtime) => runtime.name)
      if (backupFailure) failed.push("backup-scheduler")
      if (
        !personBrain &&
        getStorageRetentionSnapshot()?.results.some(
          (result) =>
            ["failed", "partial", "blocked", "unknown"].includes(result.status) ||
            (result.failed ?? 0) > 0
        )
      )
        failed.push("storage-retention")
      return [...new Set(failed)]
    },
    log: (level, message) => {
      if (level === "error") out.error(`serve: ${message}\n`)
      else out.write(`serve: ${message}\n`)
    },
  })
  bridgeRef.current = bridge
  await bridge.connect()
  const uninstallWorkerRuntime = personBrain
    ? () => undefined
    : installRemoteWorkerRuntime(workerPool)
  out.write(`serve: bridge connected (${bridgeUrl})\n`)

  // ── 6. Runtimes ────────────────────────────────────────────────────────────
  await import("@/lib/headless/runtimes")
  const resolveMessage = await loadMessageResolver("en")
  const backupFilesystem = backupFailure
    ? createUnavailableBackupFilesystem(backupFailure)
    : createNodeBackupFilesystem(backupInstallationId)
  // Account sync (ADR-0215 phase 3a): the account's own `logto login` and the
  // key store `cognia-agent account-sync` enrolls into; absent unless
  // COGNIA_ACCOUNT_SYNC is on.
  const accountSync = personBrain
    ? null
    : brainAccountSyncHost({
        cliHome,
        localAccountId,
        env,
        person,
        backup: brainBackup({
          filesystem: backupFilesystem,
          fallbackDir: path.join(home, "backups"),
        }),
      })
  const runtimes = await bootstrapHeadlessRuntimes(
    {
      host: profile.host,
      localAccountId,
      bridge,
      notifyDbWrite: durability.notifyDbWrite,
      ...(personBrain ? {} : { backupFilesystem }),
      ...(accountSync ? { accountSync } : {}),
      ...(collabReader?.runtime ? { collab: collabReader.runtime } : {}),
      ...(personBrain ? {} : { pluginRuntime: createNodePluginRuntimeAdapter() }),
      resolveMessage,
      log: (level, message) => {
        if (level === "error") out.error(`serve: ${message}\n`)
        else out.write(`serve: ${message}\n`)
      },
    },
    Date.now,
    (statuses) => {
      currentRuntimeStatus = statuses
      bridge.publishRuntimeStatus()
    }
  )
  runtimeStatus = runtimes.status
  bootstrapped = true
  bridge.publishRuntimeStatus()
  const uninstallRuntimeControl = await installRuntimeControl(
    bridge,
    runtimes,
    (level, message) => {
      if (level === "error") out.error(`serve: ${message}\n`)
      else out.write(`serve: ${message}\n`)
    }
  )
  out.write(
    `serve: runtimes up (${runtimes.started.join(", ") || "none"})` +
      (runtimes.failed.length
        ? ` — FAILED: ${runtimes.failed.map((f) => f.name).join(", ")}`
        : "") +
      "\n"
  )

  await deps.onStarted?.()

  // ── 7. Block until shutdown ────────────────────────────────────────────────
  await (deps.shutdown ??
    new Promise<void>((resolve) => {
      const onSignal = (): void => resolve()
      proc.on("SIGINT", onSignal)
      proc.on("SIGTERM", onSignal)
    }))

  out.write("serve: shutting down…\n")
  uninstallRuntimeControl()
  await runtimes.stop()
  // A stopping person brain forgets its partition key base (ADR-0253 §6).
  if (personBrain) clearPartitionArtifactKeyBase()
  collabReader?.stop()
  uninstallWorkerRuntime()
  workerPool.close()
  bridge.close()
  transport.destroy()
  await durability.dispose()
  out.write("serve: stopped\n")
  return 0
}
