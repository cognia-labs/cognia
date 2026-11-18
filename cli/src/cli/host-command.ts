/**
 * `cognia-agent host ...`, the saved hosts the API plane talks to.
 *
 * A host is an endpoint plus the credential that proves who is calling. Two
 * kinds exist because the Host admits exactly two authority modes: a loopback
 * service token on the headless wire, and a DPoP device session on the paired
 * wire. `host login` is what turns this machine into a device the owner can
 * see, grant and revoke in the Device Console.
 *
 * `host show` prints where every value came from, because the first question
 * after an unexpected 401 is always "which token did it just use".
 */

import os from "node:os"
import path from "node:path"

import { flagsMissingValues, HOST_SELECTION_FLAGS, stringFlag, type ParsedArgs } from "./args"
import { EXIT_OK, EXIT_USAGE, emitFailure, usageFailure } from "./errors"
import { emitResult, resolveOutputOptions } from "./format"
import { realOutput, type OutputSink } from "./output"
import { resolveHome } from "../config/load"
import { accountSignInDir, resolveLocalAccount } from "../config/local-account"
import {
  describePerson,
  freshSessionFor,
  personOfSession,
  readBoundPerson,
  type LogtoSessionFs,
} from "../config/logto-session"
import { loginHost, type LoginAccount } from "../host/login"
import {
  isPairInvitation,
  loginWithInvitation,
  type InvitationLoginInput,
} from "../host/pair-invitation"
import { CompanionWorkerTransport } from "../worker/companion-worker-transport"
import type { AuthFetcher } from "@/lib/tauri/companion-auth"
import { connectResolvedHost, type ConnectDeps } from "../api/connect"
import { describeResolution, loadHostsLayers, mergeHosts, resolveHost } from "../host/resolve"
import {
  addHost,
  hostsPath,
  projectHostsPath,
  readHostsFile,
  realHostsFs as realHostsFsForIgnore,
  redactHost,
  removeHost,
  activateHost,
  writeHostsFile,
  PROJECT_HOSTS_DIR,
  HOSTS_FILE_NAME,
  type HostKind,
  type HostRecord,
  type HostsFs,
} from "../host/store"

export const HOST_HELP = `cognia-agent host - the Cognia hosts this CLI can call

Usage:
  cognia-agent host add <name> --endpoint <url> [--kind headless|device]
                              [--tenant <id>] [--token <service token>]
                              [--fingerprint <sha256 hex>] [--use]
  cognia-agent host list
  cognia-agent host login <name> --invitation 'cgnp4|…' [--endpoint <url>]
                              [--label <display name>]
  cognia-agent host login <name> --endpoint <url> --pair-code <code>
                              [--fingerprint <sha256 hex>] [--tenant <id>]
                              [--label <display name>]
  cognia-agent host login <name> --endpoint <url> [--account <id>]
                              [--tenant <id>] [--fingerprint <sha256 hex>]
                              [--label <display name>]   (multi-tenant Host)
  cognia-agent host use <name>
  cognia-agent host show                 the active host, with the source of each value
  cognia-agent host remove <name> [--keep-on-host]
  cognia-agent host path                 where the hosts file lives

Flags:
  --local        write to ./.cognia/hosts.json instead of the CLI home
  --replace      let add or login replace a saved paired device of the same name
  --keep-on-host remove the local record without revoking its device on the host
  --format raw|json|pretty
  -o, --output <dir>

Revocation:
  A paired device stays registered on its host until it is revoked there.
  \`host remove\` and a \`--replace\` login first ask the host to revoke the old
  device, which needs the host.admin grant; without it, revoke the device in
  the host's Device Console or with \`cognia-server devices revoke-device <id>\`.

Project file:
  A record written with --local that holds a token or a device key keeps
  ./.cognia/hosts.json out of Git through ./.cognia/.gitignore.

Kinds:
  headless  POST /internal/_rpc, loopback service token, carries every command
  device    POST /api/_rpc, DPoP device session, execution and host-admin only

Pairing:
  An invitation from \`cognia-server pair\` or the host's pairing screen
  carries the host's address, fingerprint and tenant. A cgnp4 invitation also
  carries a relay room, so a host that does not answer on its address is paired
  through the relay instead. --endpoint overrides the address.

  A multi-tenant Host has no pairing code: the device registers as the person
  a local account is signed in as (\`cognia-agent logto login --account <id>\`,
  against the issuer the Host announces). --account picks it, else
  COGNIA_LOCAL_ACCOUNT_ID, else local_acct_a; the tenant is that sign-in's
  organization unless --tenant names it.

Secrets live in hosts.json at 0600. They are never printed back, only shown
as "(set)".
`

export interface HostCommandDeps {
  out?: OutputSink
  env?: Record<string, string | undefined>
  cwd?: string
  home?: string
  fs?: HostsFs
  /** Injected so `host login` unit-tests without a real host to pair with. */
  login?: Partial<Parameters<typeof loginHost>[0]>
  /** Injected relay, probe and registration fakes for invitation logins. */
  invitationLogin?: Partial<InvitationLoginInput>
  /** The direct route's fetcher. Defaults to one that pins the host's TLS key. */
  fetcher?: AuthFetcher
  /** How `host remove` and a `--replace` login reach the host to revoke a device. */
  connectDeps?: ConnectDeps
  /** Injected so tests need no DPoP exchange; defaults to {@link revokeOnHost}. */
  revokeDevice?: (
    name: string,
    record: HostRecord & { deviceId: string },
    timeoutMs: number
  ) => Promise<DeviceRevocation>
  /** The local accounts' sign-in files, which a multi-tenant `host login` pairs with (tests). */
  sessionFs?: LogtoSessionFs
}

/**
 * The local account a multi-tenant `host login` registers the device for: its
 * session, but only while it still signs in as the person the account is
 * bound to.
 */
function loginAccount(home: string, accountId: string, sessionFs?: LogtoSessionFs): LoginAccount {
  const dir = accountSignInDir(home, accountId)
  return {
    id: accountId,
    session: async () => {
      const person = readBoundPerson(dir, sessionFs)
      return person ? freshSessionFor(dir, person, { sessionFs }) : null
    },
    describe: (session) => {
      const person = personOfSession(session, 0)
      return person ? describePerson(person) : "an unreadable subject"
    },
  }
}

/** Value flags of the host subcommands; a missing value is a usage error, never "absent". */
const HOST_VALUE_FLAGS = [
  ...HOST_SELECTION_FLAGS,
  "account",
  "kind",
  "token",
  "fingerprint",
  "label",
  "invitation",
  "pair-code",
] as const

function holdsDevice(record: HostRecord | undefined): record is HostRecord & { deviceId: string } {
  return Boolean(record?.deviceId && record.devicePrivateKeyJwk)
}

function holdsSecret(record: HostRecord): boolean {
  return Boolean(record.serviceToken || record.devicePrivateKeyJwk || record.relay)
}

export interface DeviceRevocation {
  deviceId: string
  revoked: boolean
  reason?: string
}

/**
 * Ask the host to revoke a saved device with that device's own credential.
 * `DELETE /api/devices/{id}` needs the host.admin grant, and raw routes have
 * no relay form, so a device without either is reported, not assumed revoked.
 */
export async function revokeOnHost(
  name: string,
  record: HostRecord & { deviceId: string },
  timeoutMs: number,
  connectDeps: ConnectDeps | undefined
): Promise<DeviceRevocation> {
  const connected = await connectResolvedHost(
    {
      name,
      kind: { value: "device", source: "user-file" },
      endpoint: { value: record.endpoint, source: "user-file" },
      ...(record.tenantId ? { tenantId: { value: record.tenantId, source: "user-file" } } : {}),
      record,
    },
    connectDeps ?? {}
  )
  if (!connected.ok)
    return { deviceId: record.deviceId, revoked: false, reason: connected.failure.error }
  try {
    const outcome = await connected.transport.request(
      "DELETE",
      `/api/devices/${encodeURIComponent(record.deviceId)}`,
      undefined,
      { timeoutMs }
    )
    return outcome.ok
      ? { deviceId: record.deviceId, revoked: true }
      : { deviceId: record.deviceId, revoked: false, reason: outcome.message }
  } finally {
    connected.transport.close?.()
  }
}

function revocationFix(revocation: DeviceRevocation): string[] {
  return revocation.revoked
    ? []
    : [
        `device ${revocation.deviceId} is still registered on the host` +
          (revocation.reason ? ` (${revocation.reason})` : ""),
        "revoke it in the host's Device Console, or on the host run " +
          `\`cognia-server devices revoke-device ${revocation.deviceId}\``,
      ]
}

/**
 * Keep a project hosts file that holds a credential out of Git. The project
 * file exists so a repository can pin its host; the token or device key a
 * `--local` write puts beside it must not be committed with it.
 */
function ensureProjectIgnore(cwd: string, fsx: HostsFs | undefined): string | null {
  const store = fsx ?? realHostsFsForIgnore
  const ignorePath = path.join(cwd, PROJECT_HOSTS_DIR, ".gitignore")
  const current = store.read(ignorePath)
  const lines = (current ?? "").split(/\r?\n/).map((line) => line.trim())
  if (lines.includes(HOSTS_FILE_NAME) || lines.includes(`/${HOSTS_FILE_NAME}`)) return null
  store.mkdirp(store.dirname(ignorePath))
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : (current ?? "")
  store.write(
    ignorePath,
    `${prefix}# Written by cognia-agent: this file holds Host credentials.\n${HOSTS_FILE_NAME}\n`,
    0o644
  )
  return `${PROJECT_HOSTS_DIR}/.gitignore`
}

/**
 * Said after a relay pairing. With a relay room of its own the CLI keeps
 * working from here (ADR-0224 A4); without one (an older host) it can only
 * use the address, which did not answer.
 */
export function relayLoginNote(endpoint: string, hasRelayRoom: boolean): string {
  if (hasRelayRoom) {
    return (
      `paired through the relay: ${endpoint} did not answer from this machine, so commands ` +
      `try it first and then go through this CLI's relay room on the host. Raw ` +
      `\`api request\` routes and --wait need the address to be reachable.`
    )
  }
  return (
    `paired through the relay: ${endpoint} did not answer from this machine, and this host ` +
    `gave the CLI no relay room, so commands are sent to that address. Use them where it is ` +
    `reachable (same network, a VPN or tunnel), or pair again with --endpoint set to the ` +
    `host's public URL.`
  )
}

function targetPath(args: ParsedArgs, home: string, cwd: string): string {
  return args.flags.local === true ? projectHostsPath(cwd) : hostsPath(home)
}

export async function hostCommand(args: ParsedArgs, deps: HostCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const cwd = deps.cwd ?? process.cwd()

  if (args.help || !args.subcommand) {
    out.write(HOST_HELP)
    return args.subcommand ? EXIT_OK : EXIT_USAGE
  }

  const options = resolveOutputOptions(args, env)
  if ("error" in options) return usageFailure(out, options.error, [options.fix])
  const missing = flagsMissingValues(args, HOST_VALUE_FLAGS)
  if (missing.length > 0)
    return usageFailure(out, `${missing.map((name) => `--${name}`).join(", ")} needs a value`, [
      "cognia-agent host --help",
    ])

  const file = targetPath(args, home, cwd)
  const local = args.flags.local === true
  const revokeDevice =
    deps.revokeDevice ??
    ((name: string, record: HostRecord & { deviceId: string }, timeoutMs: number) =>
      revokeOnHost(name, record, timeoutMs, deps.connectDeps))

  /**
   * Replace (or add) one record. A saved paired device of the same name is
   * only replaced under --replace, after its revocation was asked of the host.
   */
  const saveRecord = async (
    name: string,
    record: HostRecord,
    revokeReplaced: boolean
  ): Promise<
    | {
        ok: true
        updated: ReturnType<typeof addHost>
        replaced?: DeviceRevocation
        ignore?: string
      }
    | { ok: false; code: number }
  > => {
    const current = readHostsFile(file, deps.fs)
    const previous = current.hosts[name]
    let replaced: DeviceRevocation | undefined
    if (holdsDevice(previous) && previous.deviceId !== record.deviceId) {
      if (args.flags.replace !== true) {
        return {
          ok: false,
          code: emitFailure(
            out,
            {
              error: `host "${name}" already holds paired device ${previous.deviceId}`,
              cause: "invalid-request",
              fix: [
                `pass --replace to replace it (its revocation is asked of the host first)`,
                `or choose another name; cognia-agent host remove ${name} revokes and removes it`,
              ],
              inspect: ["cognia-agent host list"],
            },
            EXIT_USAGE
          ),
        }
      }
      if (revokeReplaced) replaced = await revokeDevice(name, previous, options.timeoutMs)
    }
    const updated = addHost(readHostsFile(file, deps.fs), name, record, {
      activate: args.flags.use === true,
    })
    writeHostsFile(file, updated, deps.fs)
    const ignore = local && holdsSecret(record) ? ensureProjectIgnore(cwd, deps.fs) : null
    return { ok: true, updated, ...(replaced ? { replaced } : {}), ...(ignore ? { ignore } : {}) }
  }

  switch (args.subcommand) {
    case "path": {
      emitResult(
        out,
        { user: hostsPath(home), project: projectHostsPath(cwd), writing: file },
        options,
        "host-path"
      )
      return EXIT_OK
    }
    case "add": {
      const name = args.positionals[0]
      const endpoint = stringFlag(args, "endpoint")
      if (!name || !endpoint) {
        return usageFailure(out, "host add needs a <name> and --endpoint", [
          "cognia-agent host add local --endpoint https://127.0.0.1:27890",
        ])
      }
      const kind = (stringFlag(args, "kind") ?? "headless") as HostKind
      if (kind !== "headless" && kind !== "device") {
        return usageFailure(out, `unknown --kind "${kind}"`, ["use headless or device"])
      }
      const record: HostRecord = {
        kind,
        endpoint,
        ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
        ...(stringFlag(args, "token") ? { serviceToken: stringFlag(args, "token") } : {}),
        ...(stringFlag(args, "fingerprint")
          ? { serverFingerprint: stringFlag(args, "fingerprint") }
          : {}),
        ...(stringFlag(args, "label") ? { label: stringFlag(args, "label") } : {}),
      }
      // A record typed in by hand has no device identity to revoke.
      const saved = await saveRecord(name, record, false)
      if (!saved.ok) return saved.code
      emitResult(
        out,
        {
          added: name,
          active: saved.updated.active,
          file,
          ...(saved.ignore ? { gitignore: saved.ignore } : {}),
          ...redactHost(saved.updated.hosts[name]),
        },
        options,
        "host-add"
      )
      return EXIT_OK
    }
    case "login": {
      const name = args.positionals[0]
      const endpoint = stringFlag(args, "endpoint")
      const invitation = stringFlag(args, "pair-code") ?? stringFlag(args, "invitation")
      // Pins the host's TLS key on the direct route; a self-signed host is
      // otherwise refused by Node before its fingerprint is ever compared.
      const fetcher = deps.fetcher ?? new CompanionWorkerTransport().fetch
      if (name && invitation && isPairInvitation(invitation)) {
        const paired = await loginWithInvitation({
          invitation,
          fetcher,
          ...(endpoint ? { endpoint } : {}),
          ...(stringFlag(args, "label") ? { displayName: stringFlag(args, "label") } : {}),
          ...(deps.invitationLogin ?? {}),
        })
        if (!paired.ok) return emitFailure(out, paired.failure)
        const saved = await saveRecord(name, paired.record, true)
        if (!saved.ok) return saved.code
        emitResult(
          out,
          {
            paired: name,
            active: saved.updated.active,
            file,
            ...(saved.ignore ? { gitignore: saved.ignore } : {}),
            ...(saved.replaced ? { replaced: saved.replaced } : {}),
            ...(saved.replaced && !saved.replaced.revoked
              ? { fix: revocationFix(saved.replaced) }
              : {}),
            path: paired.path,
            ...(paired.path === "relay"
              ? {
                  note: relayLoginNote(paired.record.endpoint, paired.record.relay !== undefined),
                }
              : {}),
            ...redactHost(paired.record),
          },
          options,
          "host-login"
        )
        return EXIT_OK
      }
      if (!name || !endpoint) {
        return usageFailure(
          out,
          "host login needs a <name> and --invitation 'cgnp4|…' (or --endpoint, with --pair-code " +
            "for a single-user Host)",
          [
            "cognia-agent host login home --invitation 'cgnp4|…'",
            "cognia-agent host login desktop --endpoint https://127.0.0.1:27890 --pair-code ABC123",
            "cognia-agent host login team --endpoint https://host.example --account work",
          ],
          [
            "run `cognia-server pair` on the host, or take one from its pairing screen",
            "a multi-tenant Host pairs as the signed-in --account instead of a code",
          ]
        )
      }
      const account = resolveLocalAccount(args, env)
      if (!account.ok) {
        return usageFailure(out, account.error, [
          "cognia-agent host login team --endpoint https://host.example --account work",
        ])
      }
      const result = await loginHost({
        endpoint,
        ...(invitation ? { invitation } : {}),
        account: loginAccount(home, account.account.id, deps.sessionFs),
        fetcher,
        ...(stringFlag(args, "label") ? { displayName: stringFlag(args, "label") } : {}),
        ...(stringFlag(args, "fingerprint")
          ? { serverFingerprint: stringFlag(args, "fingerprint") }
          : {}),
        ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
        ...(deps.login ?? {}),
      })
      if (!result.ok) return emitFailure(out, result.failure)
      const saved = await saveRecord(name, result.record, true)
      if (!saved.ok) return saved.code
      emitResult(
        out,
        {
          paired: name,
          active: saved.updated.active,
          file,
          ...(saved.ignore ? { gitignore: saved.ignore } : {}),
          ...(saved.replaced ? { replaced: saved.replaced } : {}),
          ...(saved.replaced && !saved.replaced.revoked
            ? { fix: revocationFix(saved.replaced) }
            : {}),
          ...redactHost(result.record),
        },
        options,
        "host-login"
      )
      return EXIT_OK
    }
    case "list": {
      const stored = readHostsFile(file, deps.fs)
      const rows = Object.entries(stored.hosts).map(([name, record]) => ({
        name,
        active: stored.active === name ? "yes" : "",
        ...redactHost(record),
      }))
      emitResult(out, rows, options, "host-list")
      return EXIT_OK
    }
    case "use": {
      const name = args.positionals[0]
      if (!name) return usageFailure(out, "host use needs a <name>", ["cognia-agent host list"])
      const result = activateHost(readHostsFile(file, deps.fs), name)
      if (result.error) {
        return emitFailure(
          out,
          {
            error: result.error,
            cause: "invalid-request",
            fix: ["cognia-agent host add " + name + " --endpoint <url>"],
            inspect: ["cognia-agent host list"],
          },
          EXIT_USAGE
        )
      }
      // The choice has to be the one later commands make: a project file's
      // `active` wins over the user file, and its record wins over a user
      // record of the same name.
      const layers = loadHostsLayers({ home, cwd, ...(deps.fs ? { fs: deps.fs } : {}) })
      const effective = mergeHosts(
        local ? layers.user : result.file,
        local ? result.file : layers.project
      )
      if (effective.active !== name) {
        return emitFailure(
          out,
          {
            error: `${layers.projectPath} makes "${effective.active}" the active host, and it wins over ${file}`,
            cause: "invalid-request",
            fix: [
              `cognia-agent host use ${name} --local   (change the project's choice)`,
              `or remove "active" from ${layers.projectPath}`,
            ],
            inspect: ["cognia-agent host show"],
          },
          EXIT_USAGE
        )
      }
      writeHostsFile(file, result.file, deps.fs)
      const shadowed = !local && layers.project.hosts[name] !== undefined
      emitResult(
        out,
        {
          active: name,
          file,
          record: shadowed ? layers.projectPath : file,
          ...(shadowed
            ? {
                note: `${layers.projectPath} also defines "${name}", and its record is the one used here`,
              }
            : {}),
        },
        options,
        "host-use"
      )
      return EXIT_OK
    }
    case "remove": {
      const name = args.positionals[0]
      if (!name) return usageFailure(out, "host remove needs a <name>", ["cognia-agent host list"])
      const stored = readHostsFile(file, deps.fs).hosts[name]
      const revocation =
        holdsDevice(stored) && args.flags["keep-on-host"] !== true
          ? await revokeDevice(name, stored, options.timeoutMs)
          : undefined
      const result = removeHost(readHostsFile(file, deps.fs), name)
      if (result.error) {
        return emitFailure(
          out,
          { error: result.error, cause: "invalid-request", fix: ["cognia-agent host list"] },
          EXIT_USAGE
        )
      }
      writeHostsFile(file, result.file, deps.fs)
      emitResult(
        out,
        {
          removed: name,
          active: result.file.active ?? null,
          file,
          ...(revocation ? { revokedOnHost: revocation.revoked } : {}),
          ...(revocation && !revocation.revoked ? { fix: revocationFix(revocation) } : {}),
          ...(holdsDevice(stored) && !revocation
            ? {
                fix: revocationFix({
                  deviceId: stored.deviceId,
                  revoked: false,
                  reason: "--keep-on-host",
                }),
              }
            : {}),
        },
        options,
        "host-remove"
      )
      return EXIT_OK
    }
    case "show": {
      const profile = stringFlag(args, "host") ?? stringFlag(args, "profile")
      const resolution = resolveHost({
        ...(stringFlag(args, "endpoint") ? { endpoint: stringFlag(args, "endpoint") } : {}),
        ...(profile ? { profile } : {}),
        ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
        env,
        home,
        cwd,
        ...(deps.fs ? { fs: deps.fs } : {}),
      })
      if (!resolution.host) {
        return emitFailure(out, {
          error: "no Cognia host resolves here",
          details: resolution.skipped.map((leg) => `${leg.leg}: ${leg.reason}`),
          cause: "no-host",
          fix: [
            "cognia-agent host add local --endpoint https://127.0.0.1:27890",
            "or export COGNIA_SERVER_URL and COGNIA_SERVICE_TOKEN",
          ],
          inspect: ["cognia-agent host path"],
        })
      }
      emitResult(out, describeResolution(resolution.host), options, "host-show")
      return EXIT_OK
    }
    default:
      return usageFailure(
        out,
        `unknown host subcommand "${args.subcommand}"`,
        ["cognia-agent host --help"],
        ["cognia-agent host list"]
      )
  }
}
