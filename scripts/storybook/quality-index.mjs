/** Validate the explicit build selection before any browser test can pass. */
export function qualityEntries(index, requiredFiles) {
  if (!requiredFiles.length) throw new Error("Storybook quality selection is empty")
  const entries = Object.values(index.entries ?? {}).filter(
    (entry) => entry.type === "story" && entry.tags?.includes("quality")
  )
  for (const file of requiredFiles) {
    if (!entries.some((entry) => entry.importPath.replace(/^\.\//, "") === file)) {
      throw new Error(`No quality stories indexed for ${file}`)
    }
  }
  if (!index.entries?.["documentation-overview--docs"]) {
    throw new Error("Storybook Overview docs are missing")
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id, "en"))
}
