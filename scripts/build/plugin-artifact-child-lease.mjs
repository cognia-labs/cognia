/** Node preload: acquire before compiler imports, including after wrapper death. */
import fs from "node:fs"
import path from "node:path"
import {
  withPluginArtifactLock,
  createPluginArtifactLease,
  createWindowsPluginArtifactJob,
} from "./plugin-artifact-lease.mjs"

const selected = process.env.COGNIA_PLUGIN_COMPILATION_LEASE
delete process.env.COGNIA_PLUGIN_COMPILATION_LEASE
if (selected) {
  const { root, artifactSha256 } = JSON.parse(selected)
  await withPluginArtifactLock(root, async (directory) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"), "utf8"))
    if (receipt.artifactSha256 !== artifactSha256)
      throw new Error("Plugin artifact changed before compiler startup; retry the build")
    const job = process.platform === "win32" ? await createWindowsPluginArtifactJob() : undefined
    createPluginArtifactLease(directory, artifactSha256, {
      processGroup: process.platform !== "win32",
      ...(job ? { windowsJob: job.name, windowsJobOwner: job.guardianPid } : {}),
    })
  })
}
