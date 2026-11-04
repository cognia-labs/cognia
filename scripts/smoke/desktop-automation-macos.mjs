#!/usr/bin/env node
/** Real OS recipient checks against disposable apps; run after tauri:debug:agent. */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { connectTauriPage } from "../tauri/agent-debug-client.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const [outputArgument] = process.argv.slice(process.argv[2] === "--" ? 3 : 2)
const output = path.resolve(root, outputArgument ?? ".cache/ui-automation-p1-2026-11-02/live")
assert.equal(process.platform, "darwin", "this fixture requires macOS")
await fs.mkdir(output, { recursive: true })
const page = connectTauriPage()
// The debug inspector truncates arrays/depth; a JSON string preserves the IPC wire payload.
const invoke = async (command, args = {}) =>
  JSON.parse(
    await page.evaluate(
      async ({ command, args, id }) =>
        JSON.stringify(
          await window.__TAURI_INTERNALS__.invoke(command, args, {
            headers: { "x-cognia-automation-invocation": id },
          })
        ),
      { command, args, id: randomUUID() },
      { timeout: 30000 }
    )
  )
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined)
    if (value && predicate(value)) return value
    await delay(50)
  }
  throw new Error(`fixture timeout: ${label}`)
}
const fixtures = []
const result = { runId: randomUUID(), checks: [], restored: false }
const ctx = { surface: "workflow", sessionKey: result.runId, turnKey: result.runId }
let previous
let killed
const read = (fixture) => fs.readFile(fixture.state, "utf8").then(JSON.parse)
async function command(fixture, args) {
  const id = randomUUID()
  const temporary = `${fixture.command}.${id}`
  await fs.writeFile(temporary, JSON.stringify({ window: 0, ...args, id }))
  await fs.rename(temporary, fixture.command)
  return waitFor(
    () => read(fixture),
    (state) => state.lastCommand === id,
    args.kind
  )
}
function content(state) {
  return state.windows.map(({ primary, secondary, clicks }) => ({ primary, secondary, clicks }))
}
async function checkpoint(name, check) {
  await check()
  result.checks.push(name)
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2))
  console.log(`PASS ${name}`)
}
async function observe(fixture) {
  let state
  const deadline = Date.now() + 5000
  while (true) {
    try {
      state = await invoke("desktop_get_app_state", {
        args: {
          sessionId: `${result.runId}:${fixture.name}`,
          locator: { kind: "bundleId", bundleId: fixture.bundleId },
          options: { disableDiff: true, maxNodes: 1000, maxDepth: 16 },
          ctx,
        },
      })
      break
    } catch (error) {
      if (
        (error.message.includes('"code":"STALE_ELEMENT"') ||
          error.message.includes("stale element reference")) &&
        Date.now() < deadline
      ) {
        await delay(100)
        continue
      }
      const roots = await invoke("desktop_read_tree", {
        args: { ctx, opts: { maxDepth: 2 } },
      }).catch(() => [])
      result.captureDiagnostics = roots
        .filter((root) => root.processId === fixture.child.pid)
        .map(({ name, windowTitle, boundingRect, controlType, processId }) => ({
          name,
          windowTitle,
          boundingRect,
          controlType,
          processId,
        }))
      throw error
    }
  }
  assert.equal(state.app.processId, fixture.child.pid)
  assert.ok(state.surface.windowId)
  assert.ok(state.tree.nodes.length)
  return state
}
function node(state, id) {
  const match = state.tree.nodes.filter(
    ({ element }) => element.automationId === id || element.name === id
  )
  assert.equal(match.length, 1, `unique native node ${id}`)
  return match[0]
}
function elementTarget(node) {
  return { kind: "element", handle: node.handle }
}
function pixelTarget(state, item) {
  const rect = item.element.boundingRect
  assert.ok(rect)
  const surface = state.surface
  return {
    kind: "pixel",
    target: {
      sessionId: state.sessionId,
      lineageId: state.lineageId,
      revision: state.revision,
      screenshotWidth: surface.pixelWidth,
      screenshotHeight: surface.pixelHeight,
      point: {
        x: Math.round(
          ((rect.x + rect.width / 2 - surface.logicalBounds.x) * surface.pixelWidth) /
            surface.logicalBounds.width
        ),
        y: Math.round(
          ((rect.y + rect.height / 2 - surface.logicalBounds.y) * surface.pixelHeight) /
            surface.logicalBounds.height
        ),
      },
    },
  }
}
async function action(state, target, action, strategy = "auto") {
  return invoke("desktop_perform_action", {
    args: {
      request: { turnToken: state.turnToken, target, action, strategy },
      ctx,
    },
  })
}
async function focus(fixture, field = 0) {
  const state = await observe(fixture)
  const answer = await action(
    state,
    elementTarget(node(state, `fixture-field-0-${field}`)),
    { kind: "focus" },
    "semantic"
  )
  if (answer.status !== "delivered") {
    result.focusFailure = {
      surface: state.surface,
      root: state.tree.nodes[0].element,
      target: node(state, `fixture-field-0-${field}`).element,
      native: await read(fixture),
      answer,
    }
  }
  assert.equal(answer.status, "delivered", JSON.stringify(answer))
  return observe(fixture)
}
async function type(fixture, text) {
  const state = await focus(fixture)
  const answer = await action(state, elementTarget(node(state, "fixture-field-0-0")), {
    kind: "typeText",
    text,
  })
  assert.ok(["delivered", "unknown"].includes(answer.status), JSON.stringify(answer))
  return waitFor(
    () => read(fixture),
    (snapshot) => snapshot.windows[0].primary.includes(text),
    "native text"
  )
}
async function click(fixture) {
  const before = await read(fixture)
  const state = await focus(fixture)
  const target = pixelTarget(state, node(state, "fixture-button-0"))
  const answer = await action(state, target, { kind: "click", count: 1 }, "pixel")
  assert.ok(["delivered", "unknown"].includes(answer.status), JSON.stringify(answer))
  await waitFor(
    () => read(fixture),
    (snapshot) => snapshot.windows[0].clicks === before.windows[0].clicks + 1,
    "native click"
  )
  return state
}
async function refused(answer) {
  assert.ok(["refused", "notDelivered"].includes(answer.status), JSON.stringify(answer))
}
async function saveFrame(fixture, label) {
  const state = await observe(fixture)
  assert.ok(state.screenshot?.bytes)
  await fs.writeFile(
    path.join(output, `${label}.png`),
    Buffer.from(state.screenshot.bytes, "base64")
  )
  await fs.writeFile(
    path.join(output, `${label}-surface.json`),
    JSON.stringify(state.surface, null, 2)
  )
  return state
}

try {
  const capabilities = await page.capabilities()
  assert.equal(capabilities.apiVersion ?? capabilities.version, 3)
  previous = await invoke("automation_settings_get")
  killed = await invoke("automation_kill_switch_engaged")
  assert.equal(killed, false, "an existing human emergency stop must not be resumed by the fixture")
  await fs.writeFile(
    path.join(output, "initial-policy.json"),
    JSON.stringify({ previous, killed }, null, 2),
    { mode: 0o600 }
  )
  const frameTest = path.join(output, "frame-geometry-test")
  execFileSync("clang", [
    "-fobjc-arc",
    "-fblocks",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...[
      "ScreenCaptureKit",
      "CoreGraphics",
      "CoreImage",
      "CoreMedia",
      "CoreVideo",
      "Foundation",
      "ImageIO",
    ].flatMap((framework) => ["-framework", framework]),
    path.join(root, "crates/cognia-automation/native/macos/screen_capture.test.m"),
    "-o",
    frameTest,
  ])
  result.nativeFrameGeometry = execFileSync(frameTest, { encoding: "utf8" }).trim()
  console.log(result.nativeFrameGeometry)
  const binary = path.join(output, "Fixture")
  execFileSync("clang", [
    "-fobjc-arc",
    "-framework",
    "Cocoa",
    "-framework",
    "CoreGraphics",
    path.join(root, "scripts/smoke/fixtures/desktop-automation-macos.m"),
    "-o",
    binary,
  ])
  result.desktopSession = JSON.parse(
    execFileSync(binary, ["--session-status"], { encoding: "utf8" })
  )
  assert.equal(result.desktopSession.locked, false, "unlock the Mac before native input acceptance")
  assert.equal(
    result.desktopSession.onConsole,
    true,
    "native acceptance requires the active console session"
  )
  for (const name of ["Target", "Spectator"]) {
    const bundleId = `org.cognia.automation-p1.${name.toLowerCase()}`
    const bundle = path.join(output, `${name}.app`, "Contents")
    await fs.mkdir(path.join(bundle, "MacOS"), { recursive: true })
    await fs.copyFile(binary, path.join(bundle, "MacOS", "Fixture"))
    await fs.writeFile(
      path.join(bundle, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>P1 ${name}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
    )
    const fixture = {
      name,
      bundleId,
      state: path.join(output, `${name}-state.json`),
      command: path.join(output, `${name}-command.json`),
    }
    await fs.rm(fixture.state, { force: true })
    await fs.rm(fixture.command, { force: true })
    fixture.child = spawn(path.join(bundle, "MacOS", "Fixture"), [fixture.state, fixture.command], {
      stdio: "ignore",
    })
    fixtures.push(fixture)
    await waitFor(
      () => read(fixture),
      (state) => state.pid === fixture.child.pid && state.finishedLaunching,
      "native fixture startup"
    )
  }
  const [a, b] = fixtures
  const apps = await waitFor(
    () => invoke("desktop_list_apps", { ctx }),
    (apps) => fixtures.every((fixture) => apps.some((app) => app.processId === fixture.child.pid)),
    "LaunchServices registration for both fixtures"
  )
  const owned = apps.filter((app) =>
    fixtures.some((fixture) => fixture.child.pid === app.processId)
  )
  assert.equal(owned.length, 2)
  const settings = structuredClone(previous)
  settings.enabled = true
  settings.perSurface.workflow = {
    tier: "whitelist",
    whitelist: { processNames: owned.map((app) => app.displayName), windowTitlePatterns: [] },
  }
  settings.screenshotDedup = false
  settings.alwaysHidePictureInPicture = true
  await invoke("automation_settings_set", { settings })
  const screens = (await read(a)).screens
  assert.ok(screens.length >= 2, "two online physical displays required")
  result.screens = screens
  for (const [index, fixture] of fixtures.entries()) {
    const screen = screens[index]
    await command(fixture, { kind: "move", x: screen.x + 60, y: screen.y + 100 })
    await command(fixture, { kind: "move", window: 1, x: screen.x + 750, y: screen.y + 120 })
  }
  await command(a, { kind: "focus", field: 0 })
  const initial = await Promise.all(fixtures.map(read))
  await checkpoint(
    "display-1 native pointer and Unicode input leave spectator unchanged",
    async () => {
      const first = await click(a)
      assert.equal(first.surface.displayId, screens[0].id)
      await type(a, "A双屏🚀")
      assert.deepEqual(content(await read(b)), content(initial[1]))
      assert.deepEqual(content(await read(a))[1], content(initial[0])[1])
      await saveFrame(a, "display-1-target")
    }
  )
  await checkpoint(
    "cross-display movement refuses stale coordinates and accepts fresh observation",
    async () => {
      const state = await observe(a)
      const target = pixelTarget(state, node(state, "fixture-button-0"))
      const before = await Promise.all(fixtures.map(read))
      await command(a, { kind: "move", x: screens[1].x + 100, y: screens[1].y + 100 })
      await refused(await action(state, target, { kind: "click" }, "pixel"))
      assert.deepEqual(
        await Promise.all(fixtures.map(async (fixture) => content(await read(fixture)))),
        before.map(content)
      )
      const fresh = await click(a)
      assert.equal(fresh.surface.displayId, screens[1].id)
      await saveFrame(a, "display-2-target")
    }
  )
  await checkpoint("same-process sibling-window switch refuses old keyboard target", async () => {
    const state = await focus(a)
    const before = content(await read(a))
    await command(a, { kind: "focus", window: 1, field: 0 })
    await refused(
      await action(state, elementTarget(node(state, "fixture-field-0-0")), {
        kind: "typeText",
        text: "WRONG-WINDOW",
      })
    )
    assert.deepEqual(content(await read(a)), before)
  })
  await checkpoint("same-window control switch refuses old keyboard target", async () => {
    await command(a, { kind: "focus", field: 0 })
    const state = await observe(a)
    const before = content(await read(a))
    await command(a, { kind: "focus", field: 1 })
    await refused(
      await action(state, elementTarget(node(state, "fixture-field-0-0")), {
        kind: "typeText",
        text: "WRONG-CONTROL",
      })
    )
    assert.deepEqual(content(await read(a)), before)
  })
  await checkpoint("unlabeled native text field accepts a complete Unicode string", async () => {
    const state = await focus(a, 1)
    const before = content(await read(a))
    const text = "unlabeled-双屏🚀"
    const answer = await action(state, elementTarget(node(state, "fixture-field-0-1")), {
      kind: "typeText",
      text,
    })
    assert.ok(["delivered", "unknown"].includes(answer.status), JSON.stringify(answer))
    const after = await waitFor(
      () => read(a),
      (snapshot) => snapshot.windows[0].secondary.includes(text),
      "complete unlabeled input"
    )
    assert.equal(after.windows[0].primary, before[0].primary)
    assert.deepEqual(content(after)[1], before[1])
  })
  await checkpoint(
    "explicit cross-app focus routes native text and clicks to the second display",
    async () => {
      const beforeA = content(await read(a))
      await type(b, "B独立🚀")
      const state = await click(b)
      assert.equal(state.surface.displayId, screens[1].id)
      assert.deepEqual(content(await read(a)), beforeA)
      await saveFrame(b, "display-2-spectator-as-target")
    }
  )
  await checkpoint(
    "repeated explicit application switches preserve all sibling controls",
    async () => {
      for (let index = 0; index < 2; index++) {
        for (const fixture of fixtures) {
          const other = fixtures.find((item) => item !== fixture)
          const before = content(await read(other))
          const sibling = content(await read(fixture))[1]
          await type(fixture, `-${fixture.name}-${index}`)
          assert.deepEqual(content(await read(other)), before)
          assert.deepEqual(content(await read(fixture))[1], sibling)
        }
      }
    }
  )
  await checkpoint(
    "native key chords retain the selected application's focused control",
    async () => {
      const state = await focus(a)
      const beforeA = content(await read(a))
      const beforeB = content(await read(b))
      const answer = await action(state, elementTarget(node(state, "fixture-field-0-0")), {
        kind: "pressKey",
        chord: "Cmd+A",
      })
      assert.ok(["delivered", "unknown"].includes(answer.status), JSON.stringify(answer))
      const fresh = await observe(a)
      const text = "selected-双屏🚀"
      await action(fresh, elementTarget(node(fresh, "fixture-field-0-0")), {
        kind: "typeText",
        text,
      })
      const after = await waitFor(
        () => read(a),
        (snapshot) => snapshot.windows[0].primary === text,
        "native select-all and replacement"
      )
      assert.equal(after.windows[0].secondary, beforeA[0].secondary)
      assert.deepEqual(content(after)[1], beforeA[1])
      assert.deepEqual(content(await read(b)), beforeB)
    }
  )
  await checkpoint("resize invalidates the observed pixel surface", async () => {
    const state = await focus(b)
    const before = content(await read(b))
    await command(b, { kind: "move", x: screens[1].x + 120, y: screens[1].y + 100, width: 580 })
    await refused(
      await action(
        state,
        pixelTarget(state, node(state, "fixture-button-0")),
        { kind: "click" },
        "pixel"
      )
    )
    assert.deepEqual(content(await read(b)), before)
  })
  await checkpoint(
    "multi-click stops when its first click activates a sibling window",
    async () => {
      const state = await focus(b)
      const before = content(await read(b))
      await command(b, { kind: "interruptClicks", enabled: true })
      const answer = await action(
        state,
        elementTarget(node(state, "fixture-button-0")),
        { kind: "click", count: 2 },
        "pixel"
      )
      assert.equal(answer.status, "unknown", JSON.stringify(answer))
      const after = await waitFor(
        () => read(b),
        (snapshot) => snapshot.windows[0].clicks === before[0].clicks + 1,
        "first click only"
      )
      assert.equal(after.windows[0].clicks, before[0].clicks + 1)
      assert.deepEqual(content(after)[1], before[1])
      await command(b, { kind: "interruptClicks", enabled: false })
    }
  )
  result.final = await Promise.all(fixtures.map(read))
} catch (error) {
  result.error = error?.stack ?? String(error)
  throw error
} finally {
  try {
    if (previous) {
      await invoke("automation_settings_set", { settings: previous })
      assert.deepEqual(await invoke("automation_settings_get"), previous)
      assert.equal(await invoke("automation_kill_switch_engaged"), killed)
      result.restored = true
    }
  } finally {
    for (const fixture of fixtures) fixture.child.kill("SIGTERM")
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2))
  }
}
