import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const ENTRYPOINT = path.join(RUNTIME_DIR, "entrypoint.sh")
const DOCKERFILE = path.join(RUNTIME_DIR, "Dockerfile")

/** Run the entrypoint with every privileged command replaced by a recorder. */
async function runEntrypoint(t) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-runtime-entrypoint-"))
  t.after(() => fs.rm(bin, { recursive: true, force: true }))
  const log = path.join(bin, "calls.log")
  for (const command of ["install", "chown", "find", "gosu"]) {
    await fs.writeFile(
      path.join(bin, command),
      `#!/bin/sh\nprintf '%s' ${command} >> "${log}"\nfor arg in "$@"; do printf ' %s' "$arg" >> "${log}"; done\necho >> "${log}"\n`,
      { mode: 0o755 }
    )
  }
  execFileSync("sh", [ENTRYPOINT], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    stdio: "pipe",
  })
  return (await fs.readFile(log, "utf8")).trim().split("\n")
}

test("the runtime takes the mounts and drops to uid 10001, the uid the server and runners write as", async (t) => {
  const calls = await runEntrypoint(t)

  assert.deepEqual(calls, [
    "install -d -o 10001 -g 10001 /workspace /profiles",
    "chown 10001:10001 /workspace /profiles",
    "find /profiles -xdev ( ! -user 10001 -o ! -group 10001 ) -exec chown -h 10001:10001 {} +",
    "gosu 10001:10001 node /opt/cognia-runtime/src/main.mjs",
  ])
  // The workspace is shared with cognia-server and the runners: only its own
  // directory is taken, never the files in it. Before, the runtime handed it
  // to `pwuser`, and the server (uid 10001) could no longer write it.
  assert(!calls.some((call) => call.startsWith("find /workspace")))
  assert(!calls.some((call) => call.includes("chown -R")))
})

test("the image defines the runtime user with its own HOME and no longer uses pwuser", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    fs.readFile(DOCKERFILE, "utf8"),
    fs.readFile(ENTRYPOINT, "utf8"),
  ])

  assert.match(dockerfile, /useradd --uid 10001 --gid 10001 --home-dir \/home\/cognia/)
  assert.match(dockerfile, /install -d -o 10001 -g 10001 \/workspace \/profiles/)
  // Docker exports root's HOME and gosu keeps it, so the image must set it.
  const lastHome = [...dockerfile.matchAll(/^ENV HOME=(\S+)$/gm)].at(-1)?.[1]
  assert.equal(lastHome, "/home/cognia")
  assert.ok(dockerfile.lastIndexOf("ENV HOME=") > dockerfile.lastIndexOf("RUN "))
  assert.doesNotMatch(`${dockerfile}\n${entrypoint}`, /pwuser/)
})
