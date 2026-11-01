import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import JSZip from "jszip"

const pluginRoot = dirname(fileURLToPath(import.meta.url))
export const ENTRIES = JSON.parse(readFileSync(resolve(pluginRoot, "build-entries.json"), "utf8"))

/** Standalone CommonJS package. Only the public SDK is supplied by the Host. */
export async function buildPlugin({ outputDirectory = pluginRoot } = {}) {
  const manifestBytes = await readFile(resolve(pluginRoot, "plugin.json"))
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  const archive = new JSZip()
  const fileOptions = { date: new Date("1980-01-01T00:00:00Z"), createFolders: false }
  archive.file("plugin.json", manifestBytes, fileOptions)
  const entryPaths = {}
  for (const [output, source] of Object.entries(ENTRIES)) {
    const result = await build({
      absWorkingDir: pluginRoot,
      entryPoints: [resolve(pluginRoot, source)],
      bundle: true,
      format: "cjs",
      platform: "neutral",
      target: "es2022",
      external: ["@cognia/plugin-sdk", "@cognia/plugin-sdk/*"],
      write: false,
    })
    const bundle = result.outputFiles[0].contents
    archive.file(output, bundle, fileOptions)
    const entryPath = resolve(outputDirectory, output)
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, bundle)
    entryPaths[output] = entryPath
  }
  const archivePath = resolve(outputDirectory, "dist", `${manifest.id}-${manifest.version}.zip`)
  await mkdir(dirname(archivePath), { recursive: true })
  await writeFile(
    archivePath,
    await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  )
  return { entryPaths, archivePath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildPlugin()
    .then(({ archivePath }) => console.log(`Built ${archivePath}`))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
