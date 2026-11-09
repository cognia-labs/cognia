import { test } from "node:test"
import assert from "node:assert/strict"

import { jsonSchemaPropToZod, jsonSchemaToZodShape } from "./json-schema-zod.ts"

test("jsonSchemaToZodShape returns empty shape for non-object schemas", () => {
  assert.deepEqual(jsonSchemaToZodShape(null), {})
  assert.deepEqual(jsonSchemaToZodShape(undefined), {})
  assert.deepEqual(jsonSchemaToZodShape({ type: "string" }), {})
  assert.deepEqual(jsonSchemaToZodShape({ type: "object" }), {})
})

test("jsonSchemaToZodShape produces one zod entry per declared property", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: {
      a: { type: "string" },
      b: { type: "number" },
      c: { type: "boolean" },
    },
    required: ["a"],
  })
  assert.deepEqual(Object.keys(shape).sort(), ["a", "b", "c"])
})

test("jsonSchemaPropToZod handles the common primitive types", () => {
  // Smoke-check: each call returns a zod-like object with a parse() method.
  const types = ["string", "number", "integer", "boolean", "null", "array", "object", "weird"]
  for (const t of types) {
    const schema = jsonSchemaPropToZod({ type: t }, true)
    assert.equal(typeof schema.parse, "function", `expected zod for type=${t}`)
  }
})

test("jsonSchemaPropToZod wraps non-required fields in .optional()", () => {
  const required = jsonSchemaPropToZod({ type: "string" }, true)
  const optional = jsonSchemaPropToZod({ type: "string" }, false)
  // Optional schemas expose isOptional() on zod v3+ instances.
  assert.equal(typeof required.isOptional, "function")
  assert.equal(required.isOptional(), false)
  assert.equal(optional.isOptional(), true)
})

test("jsonSchemaPropToZod preserves descriptions on known fields", () => {
  const schema = jsonSchemaPropToZod({ type: "string", description: "field docs" }, true)
  assert.equal(schema.description, "field docs")
})

test("jsonSchemaPropToZod accepts null as a declared enum member", () => {
  // `enum: [...,null]` is how a schema says "one of these, or explicitly
  // cleared". Dropping the null made this rail reject a value the schema
  // declares, while the ai-sdk rail accepted it — the same tool validating
  // differently per provider.
  const schema = jsonSchemaPropToZod({ type: ["string", "null"], enum: ["a", "b", null] }, true)
  assert.equal(schema.safeParse("a").success, true)
  assert.equal(schema.safeParse(null).success, true)
  assert.equal(schema.safeParse("nope").success, false)
})

test("jsonSchemaPropToZod maps a null-only enum to null, not to undefined", () => {
  // `enum: [null]` is legal JSON Schema for "must be null". Filtering the only
  // member out once left a union of two `z.literal(undefined)` — a schema whose
  // declared value was the one thing it rejected.
  const schema = jsonSchemaPropToZod({ enum: [null] }, true)
  assert.equal(schema.safeParse(null).success, true)
  assert.equal(schema.safeParse("a").success, false)
})

test("jsonSchemaPropToZod maps a single-member enum to that literal", () => {
  const schema = jsonSchemaPropToZod({ enum: [7] }, true)
  assert.equal(schema.safeParse(7).success, true)
  assert.equal(schema.safeParse(8).success, false)
})

test("jsonSchemaPropToZod keeps mixed-type enums exact", () => {
  const schema = jsonSchemaPropToZod({ enum: ["a", 2, true] }, true)
  for (const value of ["a", 2, true]) {
    assert.equal(schema.safeParse(value).success, true, `expected ${String(value)} to parse`)
  }
  assert.equal(schema.safeParse("2").success, false)
})

test("jsonSchemaPropToZod maps oneOf to a real union", () => {
  // The model-visible MCP schema is derived from THIS zod shape, not from the
  // manifest JSON Schema. Before `oneOf` was handled, every discriminated
  // union fell through to `z.unknown()` — which is how computer-use's entire
  // action vocabulary reached the model as an opaque object.
  const schema = jsonSchemaPropToZod(
    {
      oneOf: [
        { type: "object", properties: { kind: { const: "click" } }, required: ["kind"] },
        {
          type: "object",
          properties: { kind: { const: "pressKey" }, chord: { type: "string" } },
          required: ["kind", "chord"],
        },
      ],
    },
    true
  )
  assert.equal(schema.safeParse({ kind: "click" }).success, true)
  assert.equal(schema.safeParse({ kind: "pressKey", chord: "ctrl+c" }).success, true)
  assert.equal(schema.safeParse({ kind: "nope" }).success, false)
})

test("jsonSchemaPropToZod treats anyOf like oneOf", () => {
  const schema = jsonSchemaPropToZod({ anyOf: [{ type: "string" }, { type: "number" }] }, true)
  assert.equal(schema.safeParse("a").success, true)
  assert.equal(schema.safeParse(3).success, true)
  assert.equal(schema.safeParse(true).success, false)
})

test("jsonSchemaPropToZod keeps a single-branch oneOf as that branch", () => {
  const schema = jsonSchemaPropToZod({ oneOf: [{ type: "string" }] }, true)
  assert.equal(schema.safeParse("a").success, true)
  assert.equal(schema.safeParse(1).success, false)
})

test("jsonSchemaPropToZod keeps string, number and array bounds", () => {
  const name = jsonSchemaPropToZod(
    { type: "string", minLength: 2, maxLength: 3, pattern: "^a" },
    true
  )
  assert.equal(name.safeParse("ab").success, true)
  assert.equal(name.safeParse("a").success, false)
  assert.equal(name.safeParse("abcd").success, false)
  assert.equal(name.safeParse("bb").success, false)
  // An unsupported pattern is dropped rather than bricking the tool.
  assert.equal(
    jsonSchemaPropToZod({ type: "string", pattern: "(" }, true).safeParse("x").success,
    true
  )

  const count = jsonSchemaPropToZod({ type: "integer", minimum: 1, exclusiveMaximum: 5 }, true)
  assert.equal(count.safeParse(4).success, true)
  assert.equal(count.safeParse(5).success, false)
  assert.equal(count.safeParse(1.5).success, false)

  const list = jsonSchemaPropToZod({ type: "array", items: { type: "string" }, maxItems: 1 }, true)
  assert.equal(list.safeParse(["a"]).success, true)
  assert.equal(list.safeParse(["a", "b"]).success, false)
  assert.equal(list.safeParse([1]).success, false)
})

test("jsonSchemaPropToZod recurses into nested objects and honours additionalProperties", () => {
  const open = jsonSchemaPropToZod(
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    true
  )
  assert.deepEqual(open.parse({ id: "a", extra: 1 }), { id: "a", extra: 1 })
  assert.equal(open.safeParse({}).success, false)
  const closed = jsonSchemaPropToZod(
    { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
    true
  )
  assert.equal(closed.safeParse({ id: "a", extra: 1 }).success, false)
  // An object without properties stays an open record.
  assert.equal(jsonSchemaPropToZod({ type: "object" }, true).safeParse({ any: 1 }).success, true)
})

test("jsonSchemaPropToZod applies a default only to an optional field", () => {
  const optional = jsonSchemaPropToZod({ type: "number", default: 3 }, false)
  assert.equal(optional.parse(undefined), 3)
  const required = jsonSchemaPropToZod({ type: "number", default: 3 }, true)
  assert.equal(required.safeParse(undefined).success, false)
})

test("jsonSchemaPropToZod maps const to a literal", () => {
  const schema = jsonSchemaPropToZod({ const: "fixed" }, true)
  assert.equal(schema.safeParse("fixed").success, true)
  assert.equal(schema.safeParse("other").success, false)
})

test("object conversion respects closed empty objects and typed additional properties", () => {
  const closed = jsonSchemaPropToZod({ type: "object", additionalProperties: false }, true)
  assert.equal(closed.safeParse({}).success, true)
  assert.equal(closed.safeParse({ extra: 1 }).success, false)
  const typed = jsonSchemaPropToZod(
    { type: "object", additionalProperties: { type: "integer", maximum: 2 } },
    true
  )
  assert.equal(typed.safeParse({ extra: 1 }).success, true)
  assert.equal(typed.safeParse({ extra: 3 }).success, false)
})

const schemaCompatibilityCases = [
  {
    name: "patternProperties",
    schema: {
      type: "object",
      patternProperties: { "^safe_": { type: "string" } },
      additionalProperties: false,
    },
    legal: [{ safe_name: "ok" }],
    illegal: [{ safe_name: 42 }, { other: "ok" }],
  },
  {
    name: "overlapping patterns",
    schema: {
      type: "object",
      patternProperties: { "^safe_": { type: "string" }, name$: { minLength: 2 } },
      additionalProperties: { type: "number" },
    },
    legal: [{ safe_name: "ok", other: 1 }],
    illegal: [{ safe_name: "x" }, { other: "bad" }],
  },
  {
    name: "oneOf",
    schema: { oneOf: [{ type: "number" }, { type: "integer" }] },
    legal: [1.5],
    illegal: [1, "bad"],
  },
  {
    name: "anyOf",
    schema: {
      anyOf: [
        { type: "string", minLength: 2 },
        { type: "number", maximum: 2 },
      ],
    },
    legal: ["ok", 1],
    illegal: [true, 3, "x"],
  },
  {
    name: "allOf",
    schema: {
      allOf: [
        { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
        { properties: { value: { maximum: 2 } } },
      ],
    },
    legal: [{ value: 1 }],
    illegal: [{ value: 3 }, {}],
  },
  {
    name: "structured const",
    schema: { const: { list: [1, null] } },
    legal: [{ list: [1, null] }],
    illegal: [{ list: [2, null] }, {}],
  },
  {
    name: "mixed enum",
    schema: { enum: ["fixed", 2, null, { ok: true }, [1, 2]] },
    legal: ["fixed", 2, null, { ok: true }, [1, 2]],
    illegal: [false, { ok: false }, [2, 1]],
  },
  {
    name: "nullable",
    schema: { type: "string", nullable: true, minLength: 2 },
    legal: [null, "ok"],
    illegal: [1, "x"],
  },
  {
    name: "type arrays",
    schema: { type: ["string", "null"], minLength: 2 },
    legal: [null, "ok"],
    illegal: [true, "x"],
  },
  {
    name: "dependentRequired",
    schema: { type: "object", dependentRequired: { token: ["owner"] } },
    legal: [{}, { token: "t", owner: "o" }],
    illegal: [{ token: "t" }],
  },
  {
    name: "propertyNames",
    schema: { type: "object", propertyNames: { pattern: "^safe_" } },
    legal: [{ safe_name: "ok" }],
    illegal: [{ other: "ok" }],
  },
  {
    name: "local references",
    schema: {
      type: "object",
      $defs: { label: { type: "string", minLength: 2 } },
      properties: { name: { $ref: "#/$defs/label" } },
      required: ["name"],
    },
    legal: [{ name: "ok" }],
    illegal: [{ name: 1 }, { name: "x" }],
  },
  {
    name: "Unicode lengths",
    schema: { type: "string", minLength: 1, maxLength: 1 },
    legal: ["😀"],
    illegal: ["", "ab"],
  },
  {
    name: "JSON integers",
    schema: { type: "integer" },
    legal: [Number.MAX_SAFE_INTEGER + 1],
    illegal: [1.5],
  },
]
for (const fixture of schemaCompatibilityCases) {
  test(`runtime JSON Schema compatibility: ${fixture.name}`, () => {
    const schema = jsonSchemaPropToZod(fixture.schema, true)
    for (const value of fixture.legal)
      assert.equal(schema.safeParse(value).success, true, JSON.stringify(value))
    for (const value of fixture.illegal)
      assert.equal(schema.safeParse(value).success, false, JSON.stringify(value))
  })
}

test("unsupported annotations and evaluation keywords never narrow legal inputs", () => {
  for (const schema of [
    { type: "string", format: "uri-reference" },
    { type: "string", format: "future-format" },
    {
      type: "object",
      allOf: [{ properties: { safe_name: { type: "string" } } }],
      unevaluatedProperties: false,
    },
    { type: "string", $ref: "https://fixture.invalid/schema.json" },
  ]) {
    const validator = jsonSchemaPropToZod(schema, true)
    assert.equal(
      validator.safeParse(schema.type === "object" ? { safe_name: "ok" } : "relative/path").success,
      true
    )
    assert.equal(validator.safeParse(42).success, false, "supported sibling type still applies")
  }
  // Widening an unsupported oneOf branch must not turn a legal unique match
  // into an illegal overlap with the now-permissive branch.
  const relaxed = jsonSchemaPropToZod(
    { oneOf: [{ $ref: "https://fixture.invalid/schema.json" }, { type: "string" }] },
    true
  )
  assert.equal(relaxed.safeParse("ok").success, true)
})

test("unsupported constraints stay permissive inside exclusive alternatives", () => {
  for (const branch of [{ type: "future-type" }, { futureConstraint: true }]) {
    const schema = jsonSchemaPropToZod({ oneOf: [branch, { type: "string" }] }, true)
    assert.equal(schema.safeParse("ok").success, true)
  }
})

test("compositions validate raw input before optional defaults change object keys", () => {
  const schema = jsonSchemaPropToZod(
    {
      type: "object",
      properties: { name: { type: "string", default: "default" } },
      propertyNames: { pattern: "^other$" },
      maxProperties: 0,
      oneOf: [{ required: ["name"] }, { maxProperties: 0 }],
    },
    true
  )
  assert.deepEqual(schema.parse({}), { name: "default" })
  assert.equal(schema.safeParse({ name: "explicit" }).success, false)
})
