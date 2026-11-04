import { execFileSync } from "node:child_process"
import { existsSync, globSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"

/** Pack required local dependencies and peers; optional native distributions are tested separately. */
export function packWorkspaceClosure(repoRoot, rootName, destination) {
  const packages = new Map(
    readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(repoRoot, "packages", entry.name, "package.json"))
      )
      .map((entry) => {
        const directory = join(repoRoot, "packages", entry.name)
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
        return [manifest.name, { directory, manifest }]
      })
  )
  const tarballs = new Map()
  const visiting = new Set()
  function pack(name) {
    if (tarballs.has(name)) return
    if (visiting.has(name))
      throw new Error(`Workspace dependency cycle: ${[...visiting, name].join(" -> ")}`)
    const entry = packages.get(name)
    if (!entry) throw new Error(`Missing workspace dependency: ${name}`)
    visiting.add(name)
    const dependencies = {
      ...entry.manifest.dependencies,
      ...entry.manifest.peerDependencies,
    }
    for (const dependency of Object.keys(dependencies)) {
      if (packages.has(dependency)) pack(dependency)
      else if (String(dependencies[dependency]).startsWith("workspace:"))
        throw new Error(`Missing workspace dependency: ${dependency}`)
    }
    visiting.delete(name)
    const before = new Set(readdirSync(destination))
    try {
      execFileSync("pnpm", ["pack", "--pack-destination", destination], {
        cwd: entry.directory,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, pnpm_config_verify_deps_before_run: "false" },
      })
    } catch (error) {
      throw new Error(`Packing ${name} failed: ${error.stdout || error.stderr || error.message}`, {
        cause: error,
      })
    }
    const archive = readdirSync(destination).find(
      (file) => file.endsWith(".tgz") && !before.has(file)
    )
    if (!archive) throw new Error(`No tarball produced for ${name}`)
    tarballs.set(name, join(destination, archive))
  }
  pack(rootName)
  return tarballs
}

/** A dependency found through the checkout invalidates an installed-artifact test. */
export function assertIsolatedWorkspacePackages(consumer, names) {
  for (const name of names) installedWorkspacePackagePath(consumer, name)
}

export function installedWorkspacePackagePath(consumer, name) {
  const direct = join(consumer, "node_modules", name)
  const candidates = existsSync(direct)
    ? [direct]
    : globSync(`node_modules/.pnpm/*/node_modules/${name}`, { cwd: consumer }).map((file) =>
        join(consumer, file)
      )
  if (candidates.length === 0) throw new Error(`Workspace dependency is not installed: ${name}`)
  const targets = [...new Set(candidates.map((file) => realpathSync(file)))]
  for (const target of targets) {
    const location = relative(realpathSync(consumer), target)
    if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location))
      throw new Error(`Installed workspace package escapes the consumer: ${name} -> ${target}`)
  }
  return targets[0]
}
