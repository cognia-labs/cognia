import { strict as assert } from "node:assert"
import { test } from "node:test"
import { buildFlags, planeOutputSchema, standaloneSchema } from "./gen-cli-api-index.mjs"

test("nested and circular component refs stay self-contained", () => {
  const schema=standaloneSchema({$ref:"#/components/schemas/A"},{components:{schemas:{A:{type:"object",properties:{next:{$ref:"#/components/schemas/A"},child:{$ref:"#/components/schemas/B"}}},B:{type:"string"}}}})
  assert.equal(schema.$ref,"#/$defs/A")
  assert.equal(schema.$defs.A.properties.next.$ref,"#/$defs/A")
  assert.equal(schema.$defs.B.type,"string")
})
test("body intent keys and global transport keys have distinct flags", () => {
  const shape=buildFlags({type:"object",properties:{idempotencyKey:{type:"string"},timeout:{type:"integer"},muted:{type:["boolean","null"]}}})
  assert.equal(shape.flags.find(flag=>flag.name==="idempotencyKey").flag,"body-idempotency-key")
  assert.equal(shape.flags.find(flag=>flag.name==="timeout").flag,"")
  assert.equal(shape.flags.find(flag=>flag.name==="muted").nullable,true)
})
test("the device plane checks results against the service contract the Host serves it", () => {
  const typed={type:"object",required:["ok"],properties:{ok:{type:"boolean"}}}
  assert.deepEqual(planeOutputSchema({outputSchema:typed},{outputSchema:{}}),typed)
  // A device-only command keeps what its own spec says.
  assert.deepEqual(planeOutputSchema(undefined,{outputSchema:{type:"string"}}),{type:"string"})
  assert.deepEqual(planeOutputSchema({outputSchema:{}},{outputSchema:{type:"string"}}),{type:"string"})
})
