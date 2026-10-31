#!/usr/bin/env node
/** Keep generated plugin inputs leased for a compiler or development watcher. */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { stagePluginArtifacts, WEB_SECTIONS } from "./stage-plugin-artifacts.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export async function runWithPluginArtifacts({
  root = ROOT,
  args,
  env = process.env,
  prepare = stagePluginArtifacts,
} = {}) {
  if (!Array.isArray(args) || !args.length)
    throw new Error("with-plugin-artifacts requires a command after --")
  if (!["next", "node", process.execPath].includes(args[0]))
    throw new Error(
      "Plugin compilation requires a Node entry so its process family can acquire a lease before imports"
    )
  const lease = await prepare({
    root,
    env,
    hold: true,
    ...(env.NEXT_PUBLIC_PLATFORM === "mobile" ? { sections: WEB_SECTIONS } : {}),
  })
  const signals = new Map()
  try {
    const command = args[0] === "next" || args[0] === "node" ? process.execPath : args[0]
    const commandArgs =
      args[0] === "next"
        ? [
            createRequire(path.join(root, "package.json")).resolve("next/dist/bin/next"),
            ...args.slice(1),
          ]
        : args.slice(1)
    return await new Promise((resolve, reject) => {
      const childEnv = lease.artifactSha256
        ? {
            ...env,
            NODE_OPTIONS:
              `${env.NODE_OPTIONS ?? ""} --import=${new URL("./plugin-artifact-child-lease.mjs", import.meta.url).href}`.trim(),
            COGNIA_PLUGIN_COMPILATION_LEASE: JSON.stringify({
              root,
              artifactSha256: lease.artifactSha256,
            }),
          }
        : env
      const child = spawn(command, commandArgs, {
        cwd: root,
        env: childEnv,
        stdio: "inherit",
        detached: process.platform !== "win32",
      })
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const forward = () => {
          try {
            if (process.platform === "win32") child.kill(signal)
            else process.kill(-child.pid, signal)
          } catch (error) {
            if (error.code !== "ESRCH") throw error
          }
        }
        signals.set(signal, forward)
        process.on(signal, forward)
      }
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler)
    lease.release()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const result = await runWithPluginArtifacts({ args: args[0] === "--" ? args.slice(1) : args })
  if (result.signal) process.kill(process.pid, result.signal)
  else process.exitCode = result.code ?? 1
}
