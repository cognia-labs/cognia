/** Thin component/resource acceptance; full Host/native acceptance remains separate. */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { build } from "esbuild"
import JSZip from "jszip"
import { chromium, webkit, expect } from "@playwright/test"
import { buildFrontendPlugin } from "./build-frontend-plugins.mjs"
import { createPluginStyleContract } from "./plugin-styles.mjs"

const repository = process.cwd()
const ids = ["cognia-documents", "playwright-mcp", "sre-agent"]

// One valid vector page, with no external font dependency: a black rectangle
// lets the test distinguish real PDF painting from a blank white canvas.
function samplePdf() {
  const content = "0 0 0 rg 20 20 100 100 re f\n"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  test(
    `actual plugin components and packaged assets/real PDF worker in ${engine}`,
    { timeout: 90_000 },
    async (t) => {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-ui-resources-"))
      t.after(() => fs.rm(temporary, { recursive: true, force: true }))
      // The existing builder writes only to memory. A scratch root avoids its
      // optional github-bot-kit preparation mutating the shared checkout.
      await fs.writeFile(path.join(temporary, "package.json"), '{"type":"commonjs"}')
      await fs.symlink(path.join(repository, "node_modules"), path.join(temporary, "node_modules"))
      const assets = new Map()
      const manifests = {}
      const sheets = {}
      for (const id of ids) {
        const manifest = JSON.parse(
          await fs.readFile(path.join(repository, "plugins", id, "plugin.json"))
        )
        manifests[manifest.id] = manifest
        const release = await buildFrontendPlugin({
          root: temporary,
          pluginsRoot: path.join(repository, "plugins"),
          directory: id,
          moduleManifest: manifest,
          styleContract: createPluginStyleContract(repository),
        })
        const zip = new JSZip()
        for (const [name, bytes] of release.files) zip.file(name, bytes)
        const unpacked = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }))
        for (const [name, file] of Object.entries(unpacked.files)) {
          if (file.dir) continue
          const bytes = await file.async("nodebuffer")
          assert.deepEqual(bytes, release.files.get(name))
          assets.set(`/_cognia/builtin-plugins/${manifest.id}/resources/${name}`, bytes)
          assets.set(`/installed/${manifest.id}/${name}`, bytes)
        }
        sheets[manifest.id] = release.files.get(release.manifest.styles).toString()
      }
      const worker = await fs.readFile(
        path.join(repository, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")
      )
      const workerUrl = `/_cognia/shared/pdf-worker-${createHash("sha256").update(worker).digest("hex")}.mjs`
      assets.set(workerUrl, worker)
      assets.set("/sample.pdf", samplePdf())
      for (const delivery of ["builtin", "zip"]) {
        const entry = `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {Dialog,DialogContent} from '@cognia/plugin-ui';
        import {bindPluginTranslationsHost} from '@cognia/plugin-sdk/api/i18n';
        import {createDocumentResultCard} from './plugins/cognia-documents/src/card';
        import {PlaywrightSetupModal} from './plugins/playwright-mcp/src/ui/setup-modal';
        import {TimelineTable} from './plugins/sre-agent/src/panel/timeline-table';
        import {createIncident,applyTimeline} from './plugins/sre-agent/src/incident/model';
        import {injectPluginStyles} from './lib/plugin/styles/plugin-stylesheet';
        import {openPdfForRender,disposePdfWorker} from './plugins/cognia-pdf/src/pdf-engine';
        const manifests=${JSON.stringify(manifests)};
        bindPluginTranslationsHost(id => (key,params) => {
          const value=manifests[id]?.i18n?.locales?.en?.[key] ?? key;
          return String(value).replace(/\\{(\\w+)\\}/g,(_,name)=>String(params?.[name]??name));
        });
        globalThis.mountProof=(supportsScope=true)=>{
          if(!supportsScope) delete globalThis.CSSScopeRule;
          for(const [id,css] of Object.entries(${JSON.stringify(sheets)})) injectPluginStyles(id,css);
          const Card=createDocumentResultCard({openArtifact:id=>globalThis.openedArtifact=id});
          const incident=applyTimeline(createIncident({id:'proof',now:'now',title:'Proof',environment:'demo',window:{startTime:'a',endTime:'b'}}),{rows:[{time:'12:00',component:'gateway',event:'request accepted',signals:[],evidenceIds:['log_1'],sources:['logs'],confidence:1,flags:[]}]},'now');
          createRoot(document.querySelector('#documents')).render(React.createElement(Card,{part:{state:'output-available',output:{artifactId:'proof',title:'Proof document'}}}));
          createRoot(document.querySelector('#timeline')).render(React.createElement(TimelineTable,{incident,validating:false,onValidate:()=>{}}));
          createRoot(document.querySelector('#setup')).render(React.createElement(Dialog,{defaultOpen:true},React.createElement(DialogContent,{'data-plugin-root':'cognia-playwright-mcp',closeLabel:manifests['cognia-playwright-mcp'].i18n.locales.en['modal.close']},React.createElement(PlaywrightSetupModal,{onClose:()=>{}}))));
        };
        globalThis.paintProof=async()=>{
          const session=await openPdfForRender(new Uint8Array(await (await fetch('/sample.pdf')).arrayBuffer()));
          const canvas=document.querySelector('canvas'); await session.renderPage(1,canvas,{cssWidth:200,pixelRatio:1});
          const pixel=Array.from(canvas.getContext('2d').getImageData(50,120,1,1).data);
          const result={pages:session.pageCount,width:canvas.width,pixel}; await session.destroy();disposePdfWorker();return result;
        };
      `
        const bundle = await build({
          stdin: { contents: entry, resolveDir: repository, loader: "tsx" },
          bundle: true,
          write: false,
          format: "iife",
          platform: "browser",
          define: {
            "process.env": "{}",
            __COGNIA_PDF_WORKER_URL__: JSON.stringify(
              delivery === "builtin"
                ? workerUrl
                : `data:text/javascript;base64,${worker.toString("base64")}`
            ),
          },
        })
        assets.set(`/${delivery}.js`, bundle.outputFiles[0].contents)
      }
      const requests = []
      const csp = JSON.parse(await fs.readFile("src-tauri/tauri.conf.json")).app.security.csp
      const server = http.createServer((request, response) => {
        requests.push(request.url)
        if (request.url === "/") {
          response.setHeader("Content-Security-Policy", csp)
          response.setHeader("Content-Type", "text/html")
          response.end(
            '<!doctype html><style>@layer properties,theme,base,components,utilities;:root{--muted:rgb(20,40,60);--ring:rgb(90,100,110);--muted-foreground:rgb(50,60,70)}@layer base{button{padding:0;border:0;background:transparent}} </style><div id="documents" data-plugin-root="cognia-documents"></div><div id="timeline" data-plugin-root="sre-agent"></div><div id="setup"></div><canvas></canvas><img id="asset"><span class="sm:px-2" id="outside">outside</span>'
          )
          return
        }
        const bytes = assets.get(request.url)
        if (!bytes) {
          response.writeHead(404)
          response.end()
          return
        }
        response.setHeader(
          "Content-Type",
          /\.m?js$/.test(request.url)
            ? "text/javascript"
            : /\.png$/.test(request.url)
              ? "image/png"
              : "application/octet-stream"
        )
        response.end(bytes)
      })
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      t.after(() => {
        server.closeAllConnections()
        return new Promise((resolve) => server.close(resolve))
      })
      const origin = `http://127.0.0.1:${server.address().port}`
      const browser = await browserType.launch({ headless: true })
      t.after(() => browser.close())
      for (const delivery of ["builtin", "zip"]) {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
        const errors = [],
          warnings = [],
          workers = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.on("console", (message) => {
          if (/fake worker|content security/i.test(message.text())) warnings.push(message.text())
        })
        page.on("worker", (worker) => workers.push(worker.url()))
        await page.goto(origin)
        await page.addScriptTag({ url: `${origin}/${delivery}.js` })
        await page.evaluate(() => mountProof(false))
        const setup = page.getByTestId("playwright-setup-modal")
        await setup.waitFor()
        await expect(
          page.getByRole("dialog", {
            name: manifests["cognia-playwright-mcp"].i18n.locales.en["modal.title"],
          })
        ).toBeVisible()
        const link = setup.getByRole("link").first()
        await link.focus()
        assert.match(
          await link.evaluate((el) => getComputedStyle(el).textDecorationLine),
          /underline/
        )
        await page.keyboard.press("Escape")
        const open = page.getByRole("button", {
          name: manifests["cognia-documents"].i18n.locales.en["card.open"],
          exact: true,
        })
        assert.ok(
          await page
            .getByText(manifests["cognia-documents"].i18n.locales.en["card.title"], { exact: true })
            .isVisible()
        )
        assert.equal(await open.evaluate((el) => getComputedStyle(el).height), "28px")
        await open.click()
        assert.equal(await page.evaluate(() => openedArtifact), "proof")
        let row = page.getByRole("button", {
          name: manifests["sre-agent"].i18n.locales.en["timeline.showDetails"],
          exact: true,
        })
        await row.click()
        row = page.getByRole("button", {
          name: manifests["sre-agent"].i18n.locales.en["timeline.hideDetails"],
          exact: true,
        })
        assert.equal(await row.getAttribute("aria-expanded"), "true")
        await row.focus()
        // WebKit follows Safari's Option-Tab convention for focusing all controls.
        await page.keyboard.press(engine === "webkit" ? "Alt+Tab" : "Tab")
        await page.keyboard.press(engine === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab")
        assert.match(await row.evaluate((el) => getComputedStyle(el).boxShadow), /2px/)
        await page.setViewportSize({ width: 390, height: 700 })
        assert.equal(await open.evaluate((el) => getComputedStyle(el).height), "36px")
        assert.equal(await row.evaluate((el) => getComputedStyle(el).minHeight), "36px")
        const root =
          delivery === "builtin"
            ? "/_cognia/builtin-plugins/cognia-documents/resources/"
            : "/installed/cognia-documents/"
        await page.locator("#asset").evaluate((el, src) => {
          el.src = src
        }, `${origin}${root}assets/icon.png`)
        await page.waitForFunction(() => document.querySelector("#asset").naturalWidth > 0)
        assert.deepEqual(await page.evaluate(() => paintProof()), {
          pages: 1,
          width: 200,
          pixel: [0, 0, 0, 255],
        })
        assert.ok(
          workers.some((url) =>
            delivery === "builtin" ? url.endsWith(workerUrl) : url.startsWith("blob:")
          )
        )
        assert.deepEqual(errors, [])
        assert.deepEqual(warnings, [])
        if (process.env.PLUGIN_ACCEPTANCE_OUTPUT) {
          await fs.mkdir(process.env.PLUGIN_ACCEPTANCE_OUTPUT, { recursive: true })
          await page.screenshot({
            path: path.join(process.env.PLUGIN_ACCEPTANCE_OUTPUT, `${engine}-${delivery}.png`),
            fullPage: true,
          })
        }
        assert.equal(
          await page.locator("#outside").evaluate((el) => getComputedStyle(el).paddingLeft),
          "0px"
        )
        await page.close()
      }
      assert.ok(!requests.some((url) => url.startsWith("/plugins/")))
    }
  )
}
