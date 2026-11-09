// JSON Schema → Zod for both plugin-tool rails. Keep the original schema as
// metadata: converting declarations through a narrower Zod shape must never
// hide legal inputs from the model.

import { z } from "zod"

type SchemaNode = Record<string, unknown>
interface CompiledSchema {
  schema: z.ZodType
  relaxed: boolean
}

const HANDLED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "$ref",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "nullable",
  "const",
  "enum",
  "allOf",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "dependentRequired",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "items",
  "prefixItems",
  "additionalItems",
  "minItems",
  "maxItems",
])
const KNOWN_TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"])

function isObject(value: unknown): value is SchemaNode {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as SchemaNode
  const b = right as SchemaNode
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  )
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    case "object":
      return isObject(value)
    case "array":
      return Array.isArray(value)
    default:
      return true
  }
}

function patternOf(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== "string") return undefined
  try {
    return new RegExp(pattern, "u")
  } catch {
    return undefined
  }
}

function resolveRef(root: unknown, ref: unknown): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined
  if (ref === "#") return root
  if (!ref.startsWith("#/")) return undefined
  let current = root
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~")
    if (!isObject(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

function compileSchema(
  prop: unknown,
  required: boolean,
  root: unknown,
  ancestors: ReadonlySet<unknown>
): CompiledSchema {
  if (prop === false) return { schema: required ? z.never() : z.never().optional(), relaxed: false }
  if (!isObject(prop)) return { schema: z.unknown(), relaxed: prop !== true }
  // Recursive/unresolved references are permissive at that reference only.
  if (ancestors.has(prop)) return { schema: z.unknown(), relaxed: true }
  const seen = new Set([...ancestors, prop])
  const child = (value: unknown, isRequired = true) => compileSchema(value, isRequired, root, seen)
  // These keywords are not runtime assertions here. In particular `format`
  // is an annotation by default; Zod's URL/email checks can be narrower.
  const declaredTypes = Array.isArray(prop.type)
    ? prop.type
    : prop.type === undefined
      ? []
      : [prop.type]
  let relaxed =
    Object.keys(prop).some((key) => !HANDLED_KEYWORDS.has(key)) ||
    declaredTypes.some((type) => typeof type !== "string" || !KNOWN_TYPES.has(type)) ||
    prop.nullable === true
  const requiredKeys = Array.isArray(prop.required)
    ? prop.required.filter((key): key is string => typeof key === "string")
    : []
  const properties = isObject(prop.properties) ? prop.properties : {}
  const shape = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const compiled = child(value, requiredKeys.includes(key))
      relaxed ||= compiled.relaxed
      return [key, compiled.schema]
    })
  )
  const objectSchema = z.object(shape).passthrough()
  const patterns = Object.entries(
    isObject(prop.patternProperties) ? prop.patternProperties : {}
  ).map(([pattern, value]) => {
    const regex = patternOf(pattern)
    const compiled = child(value)
    relaxed ||= !regex || compiled.relaxed
    return { regex, compiled }
  })
  const additional =
    prop.additionalProperties === undefined ? undefined : child(prop.additionalProperties)
  const propertyNames = prop.propertyNames === undefined ? undefined : child(prop.propertyNames)
  const refTarget = resolveRef(root, prop.$ref)
  const reference = refTarget === undefined ? undefined : child(refTarget)
  if (prop.$ref !== undefined && !reference) relaxed = true
  const compositions = ["allOf", "anyOf", "oneOf"].map((keyword) => ({
    keyword,
    branches: Array.isArray(prop[keyword])
      ? prop[keyword].map((branch) => child(branch))
      : undefined,
  }))
  const tuple = Array.isArray(prop.prefixItems)
    ? prop.prefixItems
    : Array.isArray(prop.items)
      ? prop.items
      : undefined
  const positional = tuple?.map((item) => child(item))
  const rest = tuple ? (Array.isArray(prop.items) ? prop.additionalItems : prop.items) : prop.items
  const items = rest === undefined ? undefined : child(rest)
  const stringPattern = patternOf(prop.pattern)
  if (prop.pattern !== undefined && !stringPattern) relaxed = true
  relaxed ||= [
    ...patterns.map(({ compiled }) => compiled),
    additional,
    propertyNames,
    reference,
    items,
    ...(positional ?? []),
    ...compositions.flatMap(({ branches }) => branches ?? []),
  ].some((compiled) => compiled?.relaxed)

  let schema: z.ZodType = z
    .unknown()
    .check((payload) => {
      const value = payload.value
      const fail = (message: string, path: PropertyKey[] = []) => {
        payload.issues.push({ code: "custom", input: value, message, path })
      }
      const validate = (compiled: CompiledSchema, input: unknown, path: PropertyKey[] = []) => {
        const parsed = compiled.schema.safeParse(input)
        if (!parsed.success)
          for (const issue of parsed.error.issues) fail(issue.message, [...path, ...issue.path])
        return parsed
      }
      if (value === null && prop.nullable === true) return
      const types = Array.isArray(prop.type) ? prop.type : [prop.type]
      if (!types.some((type) => matchesType(type, value))) fail(`expected ${types.join(" or ")}`)
      if (Object.hasOwn(prop, "const") && !sameJson(value, prop.const)) fail("does not match const")
      if (Array.isArray(prop.enum) && !prop.enum.some((member) => sameJson(value, member)))
        fail("does not match enum")
      if (reference) validate(reference, value)
      for (const { keyword, branches } of compositions) {
        if (!branches) continue
        const count = branches.filter((branch) => branch.schema.safeParse(value).success).length
        // A widened unsupported branch can create a spurious XOR overlap.
        const valid =
          keyword === "allOf"
            ? count === branches.length
            : keyword === "oneOf" && !relaxed
              ? count === 1
              : count > 0
        if (!valid) fail(`does not match ${keyword}`)
      }
      if (typeof value === "string") {
        const length = Array.from(value).length
        if (typeof prop.minLength === "number" && length < prop.minLength)
          fail(`must contain at least ${prop.minLength} characters`)
        if (typeof prop.maxLength === "number" && length > prop.maxLength)
          fail(`must contain at most ${prop.maxLength} characters`)
        if (stringPattern && !stringPattern.test(value)) fail("does not match pattern")
      }
      if (typeof value === "number") {
        if (
          typeof prop.minimum === "number" &&
          (value < prop.minimum || (prop.exclusiveMinimum === true && value === prop.minimum))
        )
          fail("below minimum")
        if (
          typeof prop.maximum === "number" &&
          (value > prop.maximum || (prop.exclusiveMaximum === true && value === prop.maximum))
        )
          fail("above maximum")
        if (typeof prop.exclusiveMinimum === "number" && value <= prop.exclusiveMinimum)
          fail("below exclusive minimum")
        if (typeof prop.exclusiveMaximum === "number" && value >= prop.exclusiveMaximum)
          fail("above exclusive maximum")
      }
      if (isObject(value)) {
        for (const key of requiredKeys)
          if (!Object.hasOwn(value, key)) fail("required property is missing", [key])
        const keys = Object.keys(value)
        if (typeof prop.minProperties === "number" && keys.length < prop.minProperties)
          fail("below minProperties")
        if (typeof prop.maxProperties === "number" && keys.length > prop.maxProperties)
          fail("above maxProperties")
        for (const key of keys) {
          if (propertyNames) validate(propertyNames, key, [key])
          let matched = Object.hasOwn(properties, key)
          for (const { regex, compiled } of patterns) {
            if (!regex) {
              matched = true
              continue
            }
            if (regex.test(key)) {
              matched = true
              validate(compiled, value[key], [key])
            }
          }
          if (!matched && additional) validate(additional, value[key], [key])
        }
        if (isObject(prop.dependentRequired))
          for (const [key, dependencies] of Object.entries(prop.dependentRequired)) {
            if (Object.hasOwn(value, key) && Array.isArray(dependencies))
              for (const dependency of dependencies) {
                if (typeof dependency === "string" && !Object.hasOwn(value, dependency))
                  fail(`required by ${key}`, [dependency])
              }
          }
        const parsed = validate({ schema: objectSchema, relaxed: false }, value)
        if (parsed.success) payload.value = parsed.data
      }
      if (Array.isArray(value)) {
        if (typeof prop.minItems === "number" && value.length < prop.minItems)
          fail("below minItems")
        if (typeof prop.maxItems === "number" && value.length > prop.maxItems)
          fail("above maxItems")
        for (const [index, entry] of value.entries()) {
          const compiled = positional?.[index] ?? items
          if (compiled) validate(compiled, entry, [index])
        }
      }
    })
    .meta(prop)
  if (typeof prop.description === "string") schema = schema.describe(prop.description)
  if (!required)
    schema =
      prop.default === undefined ? schema.optional() : schema.optional().default(prop.default)
  return { schema, relaxed }
}

/** The raw-shape API retained for existing callers, with root reference scope. */
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodType> {
  if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties)) return {}
  const required = Array.isArray(schema.required) ? schema.required : []
  return Object.fromEntries(
    Object.entries(schema.properties).map(([key, prop]) => [
      key,
      compileSchema(prop, required.includes(key), schema, new Set()).schema,
    ])
  )
}

export function jsonSchemaPropToZod(prop: unknown, required: boolean): z.ZodType {
  return compileSchema(prop, required, prop, new Set()).schema
}

/** MCP needs a ZodObject, including when the manifest has root compositions. */
export function jsonSchemaToZodObject(schema: unknown) {
  const source = schema ?? { type: "object" }
  const validator = jsonSchemaPropToZod(source, true)
  return z
    .object({})
    .passthrough()
    .check((payload) => {
      const parsed = validator.safeParse(payload.value)
      if (parsed.success) payload.value = parsed.data as Record<string, unknown>
      else
        for (const issue of parsed.error.issues)
          payload.issues.push({
            code: "custom",
            path: issue.path,
            message: issue.message,
            input: payload.value,
          })
    })
    .meta(isObject(source) ? source : {})
}
