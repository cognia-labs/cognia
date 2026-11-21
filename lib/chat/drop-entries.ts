/**
 * Generic drag-drop resolution for the chat composer.
 *
 * A drop can carry plain files, whole directories, or a mix of both. The
 * renderer owns drag-drop (`dragDropEnabled: false` in `tauri.conf.json`), so a
 * dropped directory carries no absolute path and cannot become a
 * `referencedPaths` entry the way the attach menu's native folder picker does.
 * Instead we walk it with the non-standard `webkitGetAsEntry` API (the same
 * shape `components/settings/pet/pet-model-import.ts` relies on) and hand the
 * contained files to the exact attachment gate every other drop goes through —
 * size / type / count limits stay single-source.
 */

/** Hard cap on files pulled out of a dropped directory tree. */
export const MAX_DROPPED_DIR_FILES = 200

export interface DroppedFiles {
  /** Flattened files; directory members are named by their relative path. */
  files: File[]
  /** Number of top-level directories that were walked. */
  directories: number
  /** True when the walk stopped at {@link MAX_DROPPED_DIR_FILES}. */
  truncated: boolean
}

export interface DroppedFileEntry {
  /** File keeping its clean leaf filename (not a slash-joined path). */
  file: File
  /** Folder segments from the drop/selection root down to the file's parent. */
  folderPath: string[]
}

export interface DroppedFileTree {
  entries: DroppedFileEntry[]
  /** Empty directory paths that held no files, so folder imports keep them too. */
  emptyDirectories: string[][]
  directories: number
  truncated: boolean
}

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
}

interface FileEntryLike extends EntryLike {
  file(onSuccess: (file: File) => void, onError?: (err: unknown) => void): void
}

interface DirectoryEntryLike extends EntryLike {
  createReader(): {
    readEntries(onSuccess: (entries: EntryLike[]) => void, onError?: (err: unknown) => void): void
  }
}

function readFile(entry: FileEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null)
    )
  })
}

/**
 * `readEntries` returns at most one batch per call and signals completion with
 * an empty batch, so it must be drained in a loop.
 */
function readEntries(entry: DirectoryEntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader()
  return new Promise((resolve) => {
    const collected: EntryLike[] = []
    const next = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(collected)
            return
          }
          collected.push(...batch)
          next()
        },
        () => resolve(collected)
      )
    }
    next()
  })
}

/** Re-label a file with its path inside the dropped folder (`docs/readme.md`). */
function withRelativeName(file: File, relativePath: string): File {
  if (file.name === relativePath) return file
  return new File([file], relativePath, { type: file.type, lastModified: file.lastModified })
}

/**
 * Flatten a drop into files. Falls back to `dataTransfer.files` when the
 * browser exposes no entry API (or the drop carried no entries at all), which
 * keeps plain file drops working exactly as before.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFiles> {
  const plain = Array.from(dataTransfer.files ?? [])
  // `DataTransferItemList` is neutered once the drop handler returns, so every
  // entry has to be pulled out synchronously — before the first await.
  const entries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) =>
      typeof item.webkitGetAsEntry === "function"
        ? (item.webkitGetAsEntry() as EntryLike | null)
        : null
    )
    .filter((entry): entry is EntryLike => entry !== null)

  if (entries.length === 0) return { files: plain, directories: 0, truncated: false }

  const files: File[] = []
  let directories = 0
  let truncated = false

  const walk = async (entry: EntryLike, prefix: string): Promise<void> => {
    if (files.length >= MAX_DROPPED_DIR_FILES) {
      truncated = true
      return
    }
    if (entry.isFile) {
      const file = await readFile(entry as FileEntryLike)
      if (file) files.push(withRelativeName(file, `${prefix}${entry.name}`))
      return
    }
    if (!entry.isDirectory) return
    const children = await readEntries(entry as DirectoryEntryLike)
    for (const child of children) {
      await walk(child, `${prefix}${entry.name}/`)
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory) directories += 1
    await walk(entry, "")
  }

  return { files, directories, truncated }
}

function withLeafName(file: File, leafName: string): File {
  if (file.name === leafName) return file
  return new File([file], leafName, { type: file.type, lastModified: file.lastModified })
}

/**
 * Walk a drop while preserving folder structure for Files library imports.
 * Plain files keep `folderPath: []`; directory descendants carry their folder
 * chain and clean leaf filename.
 */
export async function collectDroppedFileTree(dataTransfer: DataTransfer): Promise<DroppedFileTree> {
  const plain = Array.from(dataTransfer.files ?? [])
  const rootEntries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) =>
      typeof item.webkitGetAsEntry === "function"
        ? (item.webkitGetAsEntry() as EntryLike | null)
        : null
    )
    .filter((entry): entry is EntryLike => entry !== null)

  if (rootEntries.length === 0) {
    return {
      entries: entriesFromRelativeFiles(plain),
      emptyDirectories: [],
      directories: 0,
      truncated: false,
    }
  }

  const entries: DroppedFileEntry[] = []
  const emptyDirectories: string[][] = []
  let directories = 0
  let truncated = false

  const walk = async (entry: EntryLike, folderPath: string[]): Promise<boolean> => {
    if (entries.length >= MAX_DROPPED_DIR_FILES) {
      truncated = true
      return false
    }
    if (entry.isFile) {
      const file = await readFile(entry as FileEntryLike)
      if (!file) return false
      entries.push({ file: withLeafName(file, entry.name), folderPath })
      return true
    }
    if (!entry.isDirectory) return false
    const nextPath = [...folderPath, entry.name]
    const children = await readEntries(entry as DirectoryEntryLike)
    let hadAnyChild = false
    for (const child of children) {
      if (child.isDirectory) hadAnyChild = true
      const added = await walk(child, nextPath)
      if (added) hadAnyChild = true
    }
    if (!hadAnyChild && !truncated) emptyDirectories.push(nextPath)
    return hadAnyChild
  }

  for (const entry of rootEntries) {
    if (entry.isDirectory) directories += 1
    await walk(entry, [])
  }

  return { entries, emptyDirectories, directories, truncated }
}

/**
 * Convert `<input type="file" webkitdirectory>` (or relative-named) `File`s
 * into `{ file, folderPath }` entries with clean leaf filenames.
 */
export function entriesFromRelativeFiles(files: readonly File[]): DroppedFileEntry[] {
  return files.map((file) => {
    const rel =
      typeof (file as File & { webkitRelativePath?: string }).webkitRelativePath === "string" &&
      (file as File & { webkitRelativePath?: string }).webkitRelativePath
        ? (file as File & { webkitRelativePath: string }).webkitRelativePath
        : file.name
    const segments = rel
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part !== "." && part !== "..")
    if (segments.length <= 1) return { file, folderPath: [] }
    const leaf = segments[segments.length - 1]!
    return {
      file: withLeafName(file, leaf),
      folderPath: segments.slice(0, -1),
    }
  })
}
