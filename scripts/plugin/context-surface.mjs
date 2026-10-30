/** Node-only, bidirectional verification of the public PluginContext contract. */
import { resolve } from "node:path"
import ts from "typescript"

export function callableContextPaths(program, checker, input, prefix = "", ancestors = new Set()) {
  const type = checker.getNonNullableType(input)
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return [prefix]
  if (type.isUnion()) {
    return [
      ...new Set(
        type.types.flatMap((member) =>
          callableContextPaths(program, checker, member, prefix, ancestors)
        )
      ),
    ]
  }
  if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return []
  if (ancestors.has(type) || checker.isArrayType(type) || checker.isTupleType(type)) return []
  const declarations = type.getSymbol()?.declarations ?? []
  if (
    declarations.some(
      (declaration) =>
        ts.isClassDeclaration(declaration) ||
        ts.isClassExpression(declaration) ||
        program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    )
  )
    return []
  const next = new Set(ancestors).add(type)
  return checker.getPropertiesOfType(type).flatMap((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0]
    if (!declaration) return []
    const member = checker.getTypeOfSymbolAtLocation(property, declaration)
    return callableContextPaths(
      program,
      checker,
      member,
      prefix ? `${prefix}.${property.name}` : property.name,
      next
    )
  })
}

export function inspectContextSurface(program, sourcePath, exportName = "PluginContext") {
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error(`Context source is unavailable: ${sourcePath}`)
  const checker = program.getTypeChecker()
  const sourceModule = checker.getSymbolAtLocation(source)
  const symbol =
    sourceModule &&
    checker.getExportsOfModule(sourceModule).find((entry) => entry.name === exportName)
  if (!symbol) throw new Error(`Context type ${exportName} is unavailable in ${sourcePath}`)
  const paths = callableContextPaths(program, checker, checker.getDeclaredTypeOfSymbol(symbol))
  if (!paths.length) throw new Error(`Context type ${exportName} has no inspectable methods`)
  return [...new Set(paths)].sort()
}

export function assertContextSurfaceParity(catalog, actualPaths) {
  const actual = new Set(actualPaths)
  const declared = new Set(
    catalog.apiNamespaces.flatMap((namespace) => namespace.methods.map((method) => method.id))
  )
  const missing = [...actual].filter((path) => !declared.has(path)).sort()
  const absent = [...declared].filter((path) => !actual.has(path)).sort()
  if (missing.length || absent.length) {
    throw new Error(
      [
        "PluginContext and API catalog differ:",
        ...missing.map((path) => `- missing catalog method ${path}`),
        ...absent.map((path) => `- catalog method has no public context member ${path}`),
      ].join("\n")
    )
  }
}

export function verifyPublicContextSurface(repoRoot, catalog) {
  const configPath = resolve(repoRoot, "tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot)
  const sourcePath = resolve(repoRoot, "packages/plugin-contract/src/types/plugin/plugin.ts")
  const program = ts.createProgram([sourcePath], {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    tsBuildInfoFile: undefined,
  })
  assertContextSurfaceParity(catalog, inspectContextSurface(program, sourcePath))
}
