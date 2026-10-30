import { strict as assert } from "node:assert"
import { test } from "node:test"
import { buildFlags, standaloneSchema } from "./gen-cli-api-index.mjs"

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
