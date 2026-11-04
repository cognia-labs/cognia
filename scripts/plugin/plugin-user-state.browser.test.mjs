/** Real IndexedDB/process-restart proof for the plugin migration kernel.
 * Host installation, account auth and native ledgers require separate E2E. */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { test } from "node:test"
import { build } from "esbuild"
import { chromium, webkit } from "@playwright/test"

const entry = `
  import Dexie from 'dexie';
  import {runPluginMigrations} from './lib/plugin/dexie/migration-runner';
  const db=new Dexie('plugin-state-proof');
  const retained=['plugins','pluginPermissions','wasmGrantRecords','approvedBinaries'];
  db.version(1).stores({pluginDexieMeta:'&pluginId','proof:items':'&id',plugins:'&id',pluginPermissions:'&id',wasmGrantRecords:'&id',approvedBinaries:'&id'});
  globalThis.ready=db.open();
  globalThis.seed=async()=>{
    await ready;
    await db.table('pluginDexieMeta').put({pluginId:'proof',tableNames:['proof:items'],appliedMigrationVersion:1});
    await db.table('proof:items').put({id:'existing',count:1});
    await db.table('plugins').bulkPut([{id:'proof',enabled:false,config:{choice:'keep'},source:'local',version:'1.0.0'},{id:'manual-newer',enabled:true,source:'git',version:'9.0.0'}]);
    await db.table('pluginPermissions').put({id:'proof',decision:'forbid'});
    await db.table('wasmGrantRecords').put({id:'proof',preopen:'/isolated-proof-only'});
    await db.table('approvedBinaries').put({id:'proof',sha256:'fixture-hash'});
    localStorage.setItem('cognia.bundledPluginSeed',JSON.stringify({version:1,removed:['removed-plugin']}));
  };
  globalThis.snapshot=async()=>{
    await ready;const result={};for(const name of retained)result[name]=await db.table(name).toArray();
    result.seed=localStorage.getItem('cognia.bundledPluginSeed');return result;
  };
  globalThis.data=async()=>({row:await db.table('proof:items').get('existing'),meta:await db.table('pluginDexieMeta').get('proof')});
  globalThis.migrate=async(version,mode)=>{
    await ready;
    try {
      await runPluginMigrations(db,'proof',version,[{toVersion:version,upgrade:'upgrade'}],{upgrade:async(tx)=>{
        const row=await tx.table('proof:items').get('existing');
        await tx.table('proof:items').update('existing',{count:row.count+1});
        if(mode==='fail')throw new Error('migration rejected');
        if(mode==='interrupt'){globalThis.migrationReached=true;await Dexie.waitFor(new Promise(()=>{}));}
      }});
      return {success:true};
    } catch(error){return {success:false,name:error.name,error:error.message};}
  };
`

for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  test(
    `plugin data and retained user rows survive migration failure/interruption/restart in ${engine}`,
    { timeout: 60_000 },
    async (t) => {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-user-state-"))
      let context
      t.after(async () => {
        await context?.close()
        await fs.rm(temporary, { recursive: true, force: true })
      })
      const bundle = await build({
        stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        define: { "process.env": "{}" },
      })
      const server = http.createServer((request, response) => {
        response.setHeader(
          "Content-Type",
          request.url === "/proof.js" ? "text/javascript" : "text/html"
        )
        response.end(
          request.url === "/proof.js"
            ? bundle.outputFiles[0].contents
            : '<!doctype html><script src="/proof.js"></script>'
        )
      })
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      t.after(() => {
        server.closeAllConnections()
        return new Promise((resolve) => server.close(resolve))
      })
      const origin = `http://127.0.0.1:${server.address().port}`
      const open = async () => {
        context = await browserType.launchPersistentContext(temporary, { headless: true })
        const page = context.pages()[0]
        await page.goto(origin)
        await page.evaluate(() => ready)
        return page
      }
      let page = await open()
      await page.evaluate(() => seed())
      const expected = await page.evaluate(() => snapshot())
      await context.close()

      page = await open()
      assert.deepEqual(await page.evaluate(() => snapshot()), expected)
      assert.deepEqual(await page.evaluate(() => migrate(2, "fail")), {
        success: false,
        name: "Error",
        error: "migration rejected",
      })
      assert.equal((await page.evaluate(() => data())).row.count, 1)
      assert.equal((await page.evaluate(() => data())).meta.appliedMigrationVersion, 1)
      assert.deepEqual(await page.evaluate(() => migrate(2)), { success: true })
      assert.deepEqual(await page.evaluate(() => migrate(2)), { success: true })
      await page.evaluate(() => {
        globalThis.pendingMigration = migrate(3, "interrupt")
      })
      await page.waitForFunction(() => globalThis.migrationReached === true)
      // Closing the whole persistent context terminates its browser process;
      // the pending write transaction must abort without advancing its ledger.
      await context.close()

      page = await open()
      assert.equal((await page.evaluate(() => data())).row.count, 2)
      assert.equal((await page.evaluate(() => data())).meta.appliedMigrationVersion, 2)
      assert.deepEqual(await page.evaluate(() => snapshot()), expected)
      const downgrade = await page.evaluate(() => migrate(1))
      assert.equal(downgrade.success, false)
      assert.equal(downgrade.name, "PluginDataVersionError")
      assert.equal((await page.evaluate(() => data())).row.count, 2)
      assert.deepEqual(await page.evaluate(() => snapshot()), expected)
    }
  )
}
