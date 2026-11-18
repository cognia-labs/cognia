/**
 * `cognia-agent logto <login|status|logout>` — obtain and manage an OIDC
 * session: the official Cognia account by default (ADR-0215), or a
 * self-hosted Logto deployment (ADR-0059) when its issuer is named.
 *
 * `login` with no issuer configured signs in to the official account with the
 * first-party `cognia-app` client; `--provider feishu|github|google|apple`
 * goes straight to that provider, `--switch-account` makes the issuer ask
 * again instead of answering with the person its browser session remembers,
 * and `COGNIA_ID_ISSUER` / `COGNIA_ID_AUDIENCE` point it at staging or a
 * local identity Worker.
 * `--issuer`, `--client-id` and `--resource` (or `COGNIA_LOGTO_*`) together
 * select a self-hosted Logto instead; naming only some of them is an error.
 *
 * Every subcommand acts for one local account (`--account`, else
 * `COGNIA_LOCAL_ACCOUNT_ID`, else the Host's default; `../config/local-account`),
 * the same account `serve` and `account-sync` act for. Its first sign-in binds
 * it to that person; signing in as anyone else is refused unless `--rebind`
 * says to hand the account over. `status` without `--account` lists every
 * account.
 *
 * `login` runs the authorization-code + PKCE flow: it stands up a loopback
 * callback server (`../mcp/oauth-callback-server`), opens the browser
 * (`../mcp/open-browser`), and hands both to the runtime-agnostic
 * `loginToLogto` (`@/lib/logto/client`). The resulting access token — a JWT the
 * companion gateway validates — is stored in the account's
 * `~/.cognia/accounts/<id>/logto.json` (0600). Several processes share that
 * file (the Brain refreshes it while a command signs in or out in another
 * terminal), so only the newest sign-in saves and a sign-out removes only the
 * session it revoked (`../config/logto-session`). Everything is injected so the
 * command unit-tests without sockets or a browser.
 */

import os from "node:os"

import {
  loginToLogto as defaultLogin,
  revokeLogtoToken as defaultRevoke,
  type LogtoClientConfig,
  type LogtoDrivers,
} from "@/lib/logto/client"

import {
  isOfficialIssuer,
  isOfficialSocialProvider,
  officialDeployment,
  officialLogtoConfig,
  OFFICIAL_SOCIAL_PROVIDERS,
} from "@/lib/identity/official-deployment"
import type { LogtoSession } from "@/lib/logto/client"

import { resolveHome } from "../config/load"
import {
  accountSignInDir,
  describeLocalAccountSource,
  localAccountsRoot,
  resolveLocalAccount,
  type AccountSignInDir,
  type LocalAccount,
} from "../config/local-account"
import {
  abandonLogtoLogin,
  beginLogtoLogin,
  cancelLogtoLogins,
  completeLogtoLogin,
  describePerson,
  listAccountSignIns,
  logtoSessionPath,
  personOfSession,
  readAccountSignIn,
  readLogtoSessionSnapshot,
  removeLogtoSessionFileIf,
  type AccountSignInEntry,
  type LogtoSessionFs,
} from "../config/logto-session"
import { startCallbackServer as defaultStartCallback } from "../mcp/oauth-callback-server"
import { openBrowser as defaultOpenBrowser } from "../mcp/open-browser"

import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

/** Default wait for the browser round-trip: 3 minutes. */
const DEFAULT_TIMEOUT_MS = 3 * 60_000

export interface LogtoCommandDeps {
  home?: string
  env?: Record<string, string | undefined>
  out?: OutputSink
  login?: typeof defaultLogin
  revoke?: typeof defaultRevoke
  fetchImpl?: typeof fetch
  now?: () => number
  startCallbackServer?: typeof defaultStartCallback
  openBrowser?: typeof defaultOpenBrowser
  sessionFs?: LogtoSessionFs
  timeoutMs?: number
}

export async function logtoCommand(args: ParsedArgs, deps: LogtoCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  if (!["login", "status", "logout"].includes(args.subcommand ?? "")) {
    out.error("logto: expected a subcommand — login | status | logout")
    return 2
  }
  const resolved = resolveLocalAccount(args, env)
  if (!resolved.ok) {
    out.error(`logto ${args.subcommand}: ${resolved.error}`)
    return 2
  }
  const account = resolved.account
  const dir = accountSignInDir(home, account.id)

  switch (args.subcommand) {
    case "login":
      return loginSub(args, deps, out, env, account, dir)
    case "status":
      return statusSub(args, deps, out, env, home, account)
    default:
      return logoutSub(deps, out, account, dir)
  }
}

async function loginSub(
  args: ParsedArgs,
  deps: LogtoCommandDeps,
  out: OutputSink,
  env: Record<string, string | undefined>,
  account: LocalAccount,
  dir: AccountSignInDir
): Promise<number> {
  const issuer = stringFlag(args, "issuer") ?? env.COGNIA_LOGTO_ISSUER
  const clientId = stringFlag(args, "client-id") ?? env.COGNIA_LOGTO_CLIENT_ID
  const resource = stringFlag(args, "resource") ?? env.COGNIA_LOGTO_AUDIENCE
  const provider = stringFlag(args, "provider")
  const official = !issuer && !clientId && !resource
  if (!official && (!issuer || !clientId || !resource)) {
    out.error(
      "logto login: --issuer, --client-id and --resource go together " +
        "(or set COGNIA_LOGTO_ISSUER / COGNIA_LOGTO_CLIENT_ID / COGNIA_LOGTO_AUDIENCE); " +
        "name none of them to sign in to the official Cognia account"
    )
    return 2
  }
  if (provider && (!official || !isOfficialSocialProvider(provider))) {
    out.error(
      official
        ? `logto login: --provider must be one of ${OFFICIAL_SOCIAL_PROVIDERS.join(", ")}`
        : "logto login: --provider applies to the official Cognia account only"
    )
    return 2
  }
  const scopesRaw = stringFlag(args, "scope") ?? env.COGNIA_LOGTO_SCOPES
  const scopes = scopesRaw ? scopesRaw.split(/[,\s]+/).filter(Boolean) : undefined
  const organizationId = stringFlag(args, "org") ?? env.COGNIA_LOGTO_ORG
  if (official && (organizationId || scopes)) {
    out.error(
      "logto login: --org and --scope (COGNIA_LOGTO_ORG / COGNIA_LOGTO_SCOPES) apply to a " +
        "self-hosted Logto deployment only"
    )
    return 2
  }
  const rebind = boolFlag(args, "rebind")
  const switchAccount = boolFlag(args, "switch-account")
  if (switchAccount && !official) {
    // Logto needs `prompt=consent` for its refresh token, and the client
    // sends a forced re-authentication to non-Logto issuers only.
    out.error(
      "logto login: --switch-account applies to the official Cognia account only; " +
        "sign out of the self-hosted Logto in the browser to change who signs in"
    )
    return 2
  }

  const startCallbackServer = deps.startCallbackServer ?? defaultStartCallback
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const login = deps.login ?? defaultLogin
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const sessionFs = deps.sessionFs
  const server = await startCallbackServer({})
  // Recorded before the browser opens: a later `logto login` or a
  // `logto logout` supersedes this attempt even while it is still waiting.
  const attempt = await beginLogtoLogin(dir, sessionFs)
  let settled = false
  try {
    const config: LogtoClientConfig = official
      ? officialLogtoConfig(
          // Always on for the CLI: the self-hosted web image's build flag
          // does not apply here, and COGNIA_ID_* replace the defaults.
          officialDeployment({ issuer: env.COGNIA_ID_ISSUER, audience: env.COGNIA_ID_AUDIENCE })!,
          {
            redirectUri: server.redirectUrl,
            clientKind: "native",
            ...(provider && isOfficialSocialProvider(provider) ? { socialProvider: provider } : {}),
            ...(switchAccount ? { freshLogin: true } : {}),
          }
        )
      : {
          issuer: issuer!,
          clientId: clientId!,
          redirectUri: server.redirectUrl,
          resource: resource!,
          scopes,
          organizationId,
        }
    const drivers: LogtoDrivers = {
      openUrl: async (url) => {
        const opened = await openBrowser(url)
        if (!opened) out.write(`Open this URL to sign in:\n  ${url}\n`)
      },
      waitForCode: async () => {
        const result = await server.waitForCode(timeoutMs)
        if (!result.code || !result.state) {
          throw new Error("Logto callback did not return a code")
        }
        return { code: result.code, state: result.state }
      },
    }
    const session = await login(config, drivers)
    const completion = await completeLogtoLogin(dir, attempt, session, sessionFs, {
      rebind,
      ...(deps.now ? { now: deps.now } : {}),
    })
    settled = true
    if (completion.kind !== "saved") {
      // The tokens were minted for nobody's use now: tell the issuer.
      const revoke = deps.revoke ?? defaultRevoke
      if (session.refreshToken)
        await revoke(session, session.refreshToken, "refresh_token", deps.fetchImpl)
      await revoke(session, session.accessToken, "access_token", deps.fetchImpl)
      out.error(refusedLogin(completion, account, env) + " Its tokens were revoked.")
      return 1
    }
    const who = describePerson(completion.person)
    const where = `${accountName(session)} as ${who} for account ${account.id}`
    const details =
      `  resource ${session.resource}${session.organizationId ? `, org ${session.organizationId}` : ""}\n` +
      `  saved to ${logtoSessionPath(dir)}\n`
    if (completion.binding === "rebound") {
      out.write(
        `Signed in to ${where}. Account ${account.id} now acts for this person instead of ` +
          `${describePerson(completion.previous!)}.\n` +
          details +
          `  A running \`cognia-agent serve\` for this account keeps acting for the previous ` +
          "person until it restarts; it then rebinds its data and resets its collaboration " +
          "read cursors.\n" +
          "  Account sync will not touch this person's space until you choose " +
          `\`cognia-agent account-sync data --merge\` or \`--replace\` (with --account ${account.id}).\n`
      )
      return 0
    }
    out.write(
      `Signed in to ${where}` +
        (completion.binding === "bound" ? "; the account now acts for this person.\n" : ".\n") +
        details
    )
    return 0
  } catch (err) {
    out.error(`logto login failed: ${(err as Error).message}`)
    return 1
  } finally {
    if (!settled) await abandonLogtoLogin(dir, attempt, sessionFs).catch(() => undefined)
    server.close()
  }
}

/** Why a finished sign-in was not saved for the account. */
function refusedLogin(
  completion: Exclude<Awaited<ReturnType<typeof completeLogtoLogin>>, { kind: "saved" }>,
  account: LocalAccount,
  env: Record<string, string | undefined>
): string {
  switch (completion.kind) {
    case "superseded":
      return (
        `logto login: a newer \`logto login\` or a \`logto logout\` for account ${account.id} ran ` +
        "after this sign-in started, so this one was discarded. Run `cognia-agent logto status` " +
        "to see who is signed in."
      )
    case "no-person":
      return (
        "logto login: the issuer's access token names no subject, so there is nobody to bind " +
        `account ${account.id} to.`
      )
    case "mismatch":
      return (
        `logto login: account ${account.id} acts for ${describePerson(completion.bound)} at ` +
        `${deploymentLabel(completion.bound.issuer, env)}; this sign-in was ` +
        `${describePerson(completion.incoming)}` +
        (completion.incoming.issuer === completion.bound.issuer
          ? ""
          : ` at ${deploymentLabel(completion.incoming.issuer, env)}`) +
        `. Sign in as that person, use another --account for this one, or pass --rebind to make ` +
        `account ${account.id} act for this person from now on.`
      )
  }
}

/** What to call the account a session belongs to. */
function accountName(session: { issuerKind?: string }): string {
  return session.issuerKind === "oidc" ? "your Cognia account" : "Logto"
}

/** What to call a deployment known only by its issuer. */
function deploymentLabel(issuer: string, env: Record<string, string | undefined>): string {
  const official = officialDeployment({
    issuer: env.COGNIA_ID_ISSUER,
    audience: env.COGNIA_ID_AUDIENCE,
  })
  return official && isOfficialIssuer(issuer, official) ? "your Cognia account" : `Logto ${issuer}`
}

/**
 * Revoke at the issuer, then remove the file. Revocation is best effort and
 * reported: the file is removed whether or not the issuer could be reached,
 * because a token this process has forgotten but the issuer still honours is
 * the worse of the two outcomes to hide.
 *
 * A sign-in still waiting for its browser round trip is superseded first, so
 * it cannot land after this sign-out. The file is removed only if it still
 * holds the session that was revoked: a sign-in that finished while the
 * issuer was being called is the newer intent and is kept. The account stays
 * bound to its person, so signing in as them again needs nothing more.
 */
async function logoutSub(
  deps: LogtoCommandDeps,
  out: OutputSink,
  account: LocalAccount,
  dir: AccountSignInDir
): Promise<number> {
  await cancelLogtoLogins(dir, deps.sessionFs)
  const snapshot = readLogtoSessionSnapshot(dir, deps.sessionFs)
  if (!snapshot) {
    out.write(`Account ${account.id} is not signed in; nothing to sign out of.\n`)
    return 0
  }
  const session = snapshot.session
  const name = `${accountName(session)} for account ${account.id}`
  const revoke = deps.revoke ?? defaultRevoke
  const outcomes = []
  if (session.refreshToken) {
    outcomes.push(await revoke(session, session.refreshToken, "refresh_token", deps.fetchImpl))
  }
  outcomes.push(await revoke(session, session.accessToken, "access_token", deps.fetchImpl))
  if (!(await removeLogtoSessionFileIf(dir, snapshot, deps.sessionFs))) {
    out.write(
      `Revoked the session of ${name} this sign-out started with, but a newer sign-in was ` +
        "saved meanwhile and is kept. Run `cognia-agent logto status` to see who is signed in.\n"
    )
    return 0
  }
  const failed = outcomes.find((outcome) => outcome.status === "failed")
  const summary =
    failed && failed.status === "failed"
      ? `Signed out of ${name} (removed its logto.json), but the issuer could not be told to ` +
        `revoke the token: ${failed.reason}\n`
      : outcomes.some((outcome) => outcome.status === "unsupported")
        ? `Signed out of ${name} (removed its logto.json). The issuer advertises no revocation ` +
          "endpoint, so the token expires on its own schedule.\n"
        : outcomes.some((outcome) => outcome.status === "self-expiring")
          ? `Signed out of ${name} (removed its logto.json; the session is revoked at the issuer, ` +
            "and the short-lived access token expires on its own).\n"
          : `Signed out of ${name} (removed its logto.json; tokens revoked at the issuer).\n`
  out.write(summary + switchHint(account, session))
  return 0
}

/**
 * Signing out keeps the account bound to its person, and does not sign the
 * browser out at the issuer, which may answer the next sign-in with the same
 * person without asking.
 */
function switchHint(account: LocalAccount, session: LogtoSession): string {
  const browser =
    session.issuerKind === "oidc"
      ? "; add --switch-account, since the browser may still be signed in to the issuer as this person"
      : ""
  return (
    `Account ${account.id} still acts for this person. To sign in as someone else, use another ` +
    `account (\`cognia-agent logto login --account <id>\`), or pass --rebind to hand this one ` +
    `over${browser}.\n`
  )
}

type AccountState =
  | "signed-in"
  | "access-expired"
  | "expired"
  | "signed-out"
  | "signing-in"
  | "not-signed-in"
  | "unreadable-binding"

function accountState(entry: AccountSignInEntry, now: number): AccountState {
  if (entry.personError) return "unreadable-binding"
  const session = entry.session
  if (session) {
    const expired = session.expiresAt !== undefined && session.expiresAt <= now
    if (!expired) return "signed-in"
    return session.refreshToken ? "access-expired" : "expired"
  }
  if (entry.loginInFlight) return "signing-in"
  return entry.person ? "signed-out" : "not-signed-in"
}

const STATE_TEXT: Record<AccountState, string> = {
  "signed-in": "signed in",
  "access-expired": "signed in (access token expired; refreshes on next use)",
  expired: "session expired",
  "signed-out": "signed out",
  "signing-in": "sign-in in progress",
  "not-signed-in": "not signed in",
  "unreadable-binding": "binding unreadable",
}

function statusRecord(
  entry: AccountSignInEntry,
  current: LocalAccount,
  now: number,
  env: Record<string, string | undefined>
) {
  const session = entry.session
  const person = entry.person ?? (session ? personOfSession(session, 0) : null)
  return {
    account: entry.accountId,
    selected: entry.accountId === current.id,
    ...(entry.accountId === current.id
      ? { selectedBy: describeLocalAccountSource(current.source) }
      : {}),
    state: accountState(entry, now),
    loginInFlight: entry.loginInFlight,
    person: person
      ? {
          issuer: person.issuer,
          subject: person.subject,
          ...(person.userId ? { userId: person.userId } : {}),
          ...(person.displayName ? { displayName: person.displayName } : {}),
          ...(person.email ? { email: person.email } : {}),
          ...(entry.person ? { boundAt: new Date(entry.person.boundAt).toISOString() } : {}),
        }
      : null,
    deployment: session
      ? accountName(session)
      : person
        ? deploymentLabel(person.issuer, env)
        : null,
    ...(session
      ? {
          session: {
            issuer: session.issuer,
            resource: session.resource,
            organizationId: session.organizationId ?? null,
            scopes: session.scopes,
            expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
          },
        }
      : {}),
    ...(entry.personError ? { error: entry.personError } : {}),
  }
}

function renderStatus(record: ReturnType<typeof statusRecord>): string {
  const selected = record.selectedBy ? `  (selected by ${record.selectedBy})` : ""
  const lines = [
    `Account ${record.account}${selected}`,
    `  state:      ${STATE_TEXT[record.state]}`,
  ]
  if (record.loginInFlight && record.state !== "signing-in") lines.push("  sign-in:    in progress")
  if (record.error) lines.push(`  error:      ${record.error}`)
  if (record.person) {
    lines.push(`  person:     ${describePerson(record.person)}`)
    if (record.deployment) lines.push(`  deployment: ${record.deployment}`)
  }
  if (["expired", "signed-out", "not-signed-in"].includes(record.state)) {
    lines.push(`  sign in:    cognia-agent logto login --account ${record.account}`)
  }
  if (record.session) {
    lines.push(
      `  issuer:     ${record.session.issuer}`,
      `  resource:   ${record.session.resource}`,
      `  org:        ${record.session.organizationId ?? "-"}`,
      `  scopes:     ${record.session.scopes.join(" ") || "-"}`,
      `  expires:    ${record.session.expiresAt ?? "unknown"}`
    )
  }
  return `${lines.join("\n")}\n`
}

const SIGN_IN_USAGE =
  "Run: cognia-agent logto login [--account <id>] [--provider feishu|github|google|apple]\n" +
  "  (or, for a self-hosted Logto: --issuer <url> --client-id <id> --resource <api>)\n"

function statusSub(
  args: ParsedArgs,
  deps: LogtoCommandDeps,
  out: OutputSink,
  env: Record<string, string | undefined>,
  home: string,
  account: LocalAccount
): number {
  const now = (deps.now ?? Date.now)()
  const json = boolFlag(args, "json")
  // `--account` asks about one account; otherwise every account, with the one
  // this shell acts for marked.
  const entries =
    account.source === "flag"
      ? [readAccountSignIn(accountSignInDir(home, account.id), account.id, deps.sessionFs)]
      : listAccountSignIns(home, deps.sessionFs)
  const records = entries.map((entry) => statusRecord(entry, account, now, env))
  if (json) {
    out.write(
      `${JSON.stringify(account.source === "flag" ? records[0] : { accounts: records }, null, 2)}\n`
    )
    return 0
  }
  if (records.length === 0) {
    out.write(`No local account has signed in under ${localAccountsRoot(home)}.\n${SIGN_IN_USAGE}`)
    return 0
  }
  out.write(records.map(renderStatus).join("\n"))
  if (
    records.every((record) => record.state === "not-signed-in" || record.state === "signed-out")
  ) {
    out.write(`\n${SIGN_IN_USAGE}`)
  }
  return 0
}
