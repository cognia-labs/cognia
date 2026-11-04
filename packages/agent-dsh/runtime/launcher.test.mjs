import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promisify } from "node:util"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  DSH_VERSION,
  resolveMcpConfigs,
  resolveCogniaServices,
  managedProfileManifest,
  prepareLaunch,
  resolveProductLauncher,
  waitForHostProcessLease,
  prepareManagedModulePolicy,
  transformManagedAcp,
} from "./launcher.mjs"

const HOST_NONCE = randomUUID()
test("managed ACP adaptation refuses unverified or changed source", () => {
  for (const source of [
    "",
    '} else if (event.type === "tool/result") {',
    "export const apply = () => {}",
  ])
    assert.throws(() => transformManagedAcp(source), /certified release/)
})
const HOST_NONCE_DIGEST = createHash("sha256").update(HOST_NONCE).digest("hex")
const HOST_RECORD = {
  schemaVersion: 2,
  bootId: randomUUID(),
  retirementRequired: true,
  retired: false,
}

function fixture(t) {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "cognia-dsh-launch-test-")))
  const root = join(dataRoot, "deepseek-harness")
  mkdirSync(root)
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }))
  const home = join(root, "dsh-home")
  const composition = join(root, "host.sdk-readonly.yml")
  writeFileSync(composition, "[]\n")
  return {
    dataRoot,
    root,
    home,
    composition,
    argv: ["node", "launcher.mjs", composition],
    env: { COGNIA_DSH_RUNTIME_HOME: root, DSH_HOME: home, COGNIA_DSH_WORKSPACE: root },
  }
}

test("refuses maintenance before touching the managed profile or loading upstream", async (t) => {
  const f = fixture(t)
  const maintenance = join(f.dataRoot, ".deepseek-harness-control", "maintenance")
  mkdirSync(maintenance, { recursive: true })
  writeFileSync(
    join(maintenance, "active-install.json"),
    JSON.stringify({ schemaVersion: 1, pid: process.pid, operationId: "active-install" })
  )
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./launcher.mjs", import.meta.url)), f.composition],
      {
        env: { PATH: process.env.PATH, ...f.env },
      }
    ),
    (error) => {
      assert.match(error.stderr, /maintenance/i)
      return true
    }
  )
  assert.equal(readdirSync(f.root).includes("dsh-home"), false)
  const processes = join(f.dataRoot, ".deepseek-harness-control", "processes")
  assert.deepEqual(
    readdirSync(processes).filter((name) => name.endsWith(".json")),
    []
  )
})

test("fails closed on malformed maintenance ownership before evaluating a profile", async (t) => {
  const f = fixture(t)
  const maintenance = join(f.dataRoot, ".deepseek-harness-control", "maintenance")
  mkdirSync(maintenance, { recursive: true })
  writeFileSync(join(maintenance, "unknown.json"), "{}")
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./launcher.mjs", import.meta.url)), f.composition],
      {
        env: { PATH: process.env.PATH, ...f.env },
      }
    ),
    (error) => {
      assert.match(error.stderr, /maintenance|ownership/i)
      return true
    }
  )
  assert.equal(readdirSync(f.root).includes("dsh-home"), false)
})

test("refuses a missing host lease before touching managed state", async (t) => {
  const f = fixture(t)
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./launcher.mjs", import.meta.url)), f.composition],
      {
        env: {
          PATH: process.env.PATH,
          ...f.env,
          COGNIA_DSH_PROCESS_LEASE: "de575486-460d-40ce-a4d1-b1428fa1f208",
        },
      }
    ),
    (error) => {
      assert.match(error.stderr, /host.*ownership|host.*lease/i)
      return true
    }
  )
  assert.equal(readdirSync(f.root).includes("dsh-home"), false)
})

test("uses its host-published process record without creating a child-writable lease", async (t) => {
  const f = fixture(t)
  const identity = "ed517256-9d97-4e4c-bc2c-8afc6d49c0ce"
  const processes = join(f.dataRoot, ".deepseek-harness-control", "processes")
  mkdirSync(processes, { recursive: true })
  writeFileSync(
    join(processes, `${identity}.json`),
    JSON.stringify({
      ...HOST_RECORD,
      pid: process.pid,
      childPid: process.pid,
      processId: "trusted-host",
      nonceDigest: HOST_NONCE_DIGEST,
    })
  )
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./launcher.mjs", import.meta.url)), f.composition],
      {
        env: {
          PATH: process.env.PATH,
          ...f.env,
          COGNIA_DSH_PROCESS_LEASE: identity,
          COGNIA_DSH_PROCESS_LEASE_NONCE: HOST_NONCE,
        },
      }
    ),
    (error) => {
      // The fixture runtime home holds no upstream install. Failing on it proves
      // the host ownership record admitted profile preparation: in the repo the
      // launcher cannot resolve the upstream package; in the isolated runtime
      // (CI's deepseek-runtime job) it resolves it beside the launcher and stops
      // at the fixture's missing `node_modules` instead.
      assert.match(
        error.stderr,
        /Cannot find module.*deepseek-ai|ENOENT[^\n]*deepseek-harness\/node_modules'/
      )
      return true
    }
  )
  assert.equal(readdirSync(f.root).includes("dsh-home"), true)
  assert.deepEqual(readdirSync(processes), [`${identity}.json`])
  assert.equal(JSON.parse(readFileSync(join(processes, `${identity}.json`))).childPid, process.pid)
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { main } from ${JSON.stringify(new URL("./launcher.mjs", import.meta.url).href)};
      process.argv = ['node', 'launcher.mjs', ${JSON.stringify(f.composition)}];
      await main().catch(() => {});
      console.log(JSON.stringify({
        identity: process.env.COGNIA_DSH_PROCESS_LEASE ?? null,
        nonce: process.env.COGNIA_DSH_PROCESS_LEASE_NONCE ?? null
      }));
    `,
    ],
    {
      env: {
        PATH: process.env.PATH,
        ...f.env,
        COGNIA_DSH_PROCESS_LEASE: identity,
        COGNIA_DSH_PROCESS_LEASE_NONCE: HOST_NONCE,
      },
    }
  )
  assert.deepEqual(JSON.parse(stdout), { identity: null, nonce: null })
})

test("waits for host child publication and does not interpret outer-namespace PIDs locally", async (t) => {
  const f = fixture(t)
  const identity = "740fcaf7-e319-4082-8bee-1d2b665cf09c"
  const directory = join(f.dataRoot, ".deepseek-harness-control", "processes")
  mkdirSync(directory, { recursive: true })
  const record = join(directory, `${identity}.json`)
  writeFileSync(
    record,
    JSON.stringify({ ...HOST_RECORD, pid: 2147483647, nonceDigest: HOST_NONCE_DIGEST })
  )
  let admitted = false
  const waiting = waitForHostProcessLease(f.root, identity, HOST_NONCE).then(() => {
    admitted = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(admitted, false)
  writeFileSync(
    record,
    JSON.stringify({
      ...HOST_RECORD,
      pid: 2147483647,
      childPid: 2147483646,
      nonceDigest: HOST_NONCE_DIGEST,
    })
  )
  await waiting
  assert.equal(admitted, true)
  assert.deepEqual(readdirSync(directory), [`${identity}.json`])
})

test("refuses abandoned host admission without child publication", async (t) => {
  const f = fixture(t)
  const identity = "b3db0f15-88c0-4b36-8a3c-5bc6b5a7d7c1"
  const directory = join(f.dataRoot, ".deepseek-harness-control", "processes")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${identity}.json`),
    JSON.stringify({ ...HOST_RECORD, pid: process.pid, nonceDigest: HOST_NONCE_DIGEST })
  )
  await assert.rejects(
    waitForHostProcessLease(f.root, identity, HOST_NONCE, 20),
    /did not confirm process ownership/
  )
  await assert.rejects(waitForHostProcessLease(f.root, "../other"), /identity is malformed/)
})

test("a readable stale host record cannot authorize a replayed launch", async (t) => {
  const f = fixture(t)
  const identity = randomUUID()
  const directory = join(f.dataRoot, ".deepseek-harness-control", "processes")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${identity}.json`),
    JSON.stringify({
      ...HOST_RECORD,
      pid: 2147483647,
      childPid: 2147483646,
      nonceDigest: HOST_NONCE_DIGEST,
    })
  )
  for (const nonce of [undefined, "", randomUUID()])
    await assert.rejects(waitForHostProcessLease(f.root, identity, nonce), /ownership.*nonce/i)
  assert.equal(readdirSync(f.root).includes("dsh-home"), false)
})

test("rejects an older host ownership protocol before profile preparation", async (t) => {
  const f = fixture(t)
  const identity = randomUUID()
  const directory = join(f.dataRoot, ".deepseek-harness-control", "processes")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${identity}.json`),
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      childPid: process.pid,
      nonceDigest: HOST_NONCE_DIGEST,
    })
  )
  await assert.rejects(waitForHostProcessLease(f.root, identity, HOST_NONCE), /record is malformed/)
  assert.equal(readdirSync(f.root).includes("dsh-home"), false)
})

test("host handshake rejects noncanonical boot identity", async (t) => {
  const f = fixture(t)
  const identity = randomUUID()
  const directory = join(f.dataRoot, ".deepseek-harness-control", "processes")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${identity}.json`),
    JSON.stringify({
      ...HOST_RECORD,
      bootId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      pid: process.pid,
      childPid: process.pid,
      nonceDigest: HOST_NONCE_DIGEST,
    })
  )
  await assert.rejects(waitForHostProcessLease(f.root, identity, HOST_NONCE), /record is malformed/)
  assert.equal(readdirSync(f.root).includes("dsh-home"), false)
})

test("module policy rejects writable code and remains pinned across a late symlink change", async (t) => {
  const f = fixture(t)
  const modules = join(f.root, "node_modules")
  mkdirSync(modules)
  mkdirSync(f.home)
  const installed = join(f.root, "installed.mjs")
  const mutable = join(f.home, "mutable.mjs")
  const mutableCjs = join(f.home, "mutable.cjs")
  const alias = join(f.home, "alias.mjs")
  const installedCjs = join(f.root, "installed.cjs")
  const aliasCjs = join(f.home, "alias.cjs")
  writeFileSync(installed, "export const origin = 'installation';\n")
  writeFileSync(mutable, "export const origin = 'mutable-state';\n")
  writeFileSync(mutableCjs, "module.exports = 'mutable-state';\n")
  writeFileSync(installedCjs, "module.exports = { origin: 'installation' };\n")
  symlinkSync(installed, alias)
  symlinkSync(installedCjs, aliasCjs)
  const policy = {
    runtimeHome: f.root,
    modules,
    stateRoots: [f.home],
    appBootUrl: pathToFileURL(installed).href,
    launchEnvironmentUrl: pathToFileURL(installed).href,
    launcherUrl: new URL("./launcher.mjs", import.meta.url).href,
  }
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { registerHooks, createRequire } from 'node:module';
    import { installManagedModulePolicy } from ${JSON.stringify(new URL("./launcher.mjs", import.meta.url).href)};
    const policy = installManagedModulePolicy(${JSON.stringify(policy)});
    let esmRaceSeen = false;
    let cjsRaceSeen = false;
    const race = registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (specifier === ${JSON.stringify(pathToFileURL(alias).href)}) {
        esmRaceSeen = true;
        fs.unlinkSync(${JSON.stringify(alias)}); fs.symlinkSync(${JSON.stringify(mutable)}, ${JSON.stringify(alias)});
      }
      if (specifier === ${JSON.stringify(aliasCjs)} || specifier === ${JSON.stringify(pathToFileURL(aliasCjs).href)}) {
        cjsRaceSeen = true;
        fs.unlinkSync(${JSON.stringify(aliasCjs)}); fs.symlinkSync(${JSON.stringify(mutableCjs)}, ${JSON.stringify(aliasCjs)});
      }
      return result;
    } });
    try {
      const loaded = await import(${JSON.stringify(pathToFileURL(alias).href)});
      assert.equal(loaded.origin, 'installation');
      assert.equal(esmRaceSeen, true);
      const required = createRequire(import.meta.url)(${JSON.stringify(aliasCjs)});
      assert.equal(required.origin, 'installation');
      assert.equal(cjsRaceSeen, true);
      await assert.rejects(import(${JSON.stringify(pathToFileURL(mutable).href)}), /writable state/);
      assert.throws(() => createRequire(import.meta.url)(${JSON.stringify(mutableCjs)}), /writable state/);
      await assert.rejects(import('data:text/javascript,export default 1'), /Unmanaged/);
      console.log(JSON.stringify({ pinned: true, stateCodeRefused: true }));
    } finally { race.deregister(); policy.deregister(); }
  `,
  ])
  assert.deepEqual(JSON.parse(stdout), { pinned: true, stateCodeRefused: true })
})

test("protected boot configuration cannot point into writable state", (t) => {
  const f = fixture(t)
  const launch = prepareLaunch(f.argv, f.env)
  const modules = join(f.root, "node_modules")
  mkdirSync(modules)
  const app = join(modules, "app.mjs")
  const manifest = join(modules, "package.json")
  writeFileSync(app, "export const boot = () => {};\n")
  writeFileSync(manifest, "{}\n")
  const mutable = join(f.home, "root.yml")
  writeFileSync(mutable, "[]\n")
  symlinkSync(mutable, join(f.root, "host.root.yml"))
  const installedRequire = {
    resolve: (name) => (name === "@deepseek-ai/dsh-app-boot" ? app : manifest),
  }
  assert.throws(
    () => prepareManagedModulePolicy(f.root, launch, installedRequire),
    /protected runtime code/
  )
})

test("prepares a deterministic startup-only managed profile, idempotently", (t) => {
  const f = fixture(t)
  const result = prepareLaunch(f.argv, f.env)
  assert.equal(result.profile, "cognia-sdk-readonly")
  assert.equal(result.sessionRoot, join(f.root, "sessions"))
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.home, "profiles", result.profile, "package.json"))),
    managedProfileManifest(result.profile)
  )
  assert.deepEqual(prepareLaunch(f.argv, f.env), result)
})

test("rejects missing ownership, relative/extra arguments and unowned compositions", (t) => {
  const f = fixture(t)
  assert.throws(() => prepareLaunch(f.argv, {}), /must be set/)
  assert.throws(() => prepareLaunch(["node", "launcher", "relative.yml"], f.env), /Usage/)
  assert.throws(() => prepareLaunch([...f.argv, "--patch"], f.env), /Usage/)
  const rogue = join(f.root, "rogue.yml")
  writeFileSync(rogue, "[]")
  assert.throws(() => prepareLaunch(["node", "launcher", rogue], f.env), /managed host/)
})

test("rejects sibling and nonexistent paths behind symlink escapes", (t) => {
  const f = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), "cognia-dsh-outside-"))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(outside, join(f.root, "link"))
  assert.throws(
    () => prepareLaunch(f.argv, { ...f.env, DSH_HOME: join(f.root, "link", "new-home") }),
    /inside/
  )
  assert.throws(() => prepareLaunch(f.argv, { ...f.env, DSH_HOME: f.root }), /isolated/)
  assert.throws(
    () => prepareLaunch(f.argv, { ...f.env, COGNIA_DSH_SESSION_ROOT: outside }),
    /persistence/
  )
})

test("refuses hidden patch layers and environment files before launch", (t) => {
  for (const name of [
    "cordis.patch.yml",
    ".env",
    "profiles/cognia-sdk-readonly/cordis.patch.yml",
  ]) {
    const f = fixture(t)
    prepareLaunch(f.argv, f.env)
    writeFileSync(join(f.home, name), "")
    assert.throws(() => prepareLaunch(f.argv, f.env), /Unmanaged DSH/)
  }
})

test("refuses profile dependency injection and symlinked profile directories", (t) => {
  const f = fixture(t)
  prepareLaunch(f.argv, f.env)
  const path = join(f.home, "profiles", "cognia-sdk-readonly", "package.json")
  writeFileSync(
    path,
    JSON.stringify({
      ...managedProfileManifest("cognia-sdk-readonly"),
      dependencies: { evil: "*" },
    })
  )
  assert.throws(() => prepareLaunch(f.argv, f.env), /manifest differs/)
  const second = fixture(t)
  mkdirSync(join(second.home, "profiles"), { recursive: true })
  symlinkSync(f.root, join(second.home, "profiles", "cognia-sdk-readonly"))
  assert.throws(() => prepareLaunch(second.argv, second.env), /escapes/)
})

test("rejects stale installed runtime packages before evaluating upstream code", (t) => {
  const f = fixture(t)
  const pkg = join(f.root, "package.json")
  writeFileSync(pkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.6" }))
  assert.throws(() => resolveProductLauncher({ resolve: () => pkg }), /Unsupported/)
  writeFileSync(pkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0-rc.2" }))
  assert.throws(() => resolveProductLauncher({ resolve: () => pkg }), /reinstall.*0.2.1-rc.2/)
  writeFileSync(pkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: DSH_VERSION }))
  assert.equal(resolveProductLauncher({ resolve: () => pkg }), join(f.root, "lib", "bin.js"))
})

test("concurrent agents publish the same complete profile manifest", async (t) => {
  const f = fixture(t)
  const code = `import { prepareLaunch } from ${JSON.stringify(new URL("./launcher.mjs", import.meta.url).href)}; prepareLaunch(${JSON.stringify(f.argv)}, ${JSON.stringify(f.env)})`
  await Promise.all(
    Array.from({ length: 8 }, () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", code])
    )
  )
  assert.deepEqual(readdirSync(join(f.home, "profiles", "cognia-sdk-readonly")), ["package.json"])
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.home, "profiles", "cognia-sdk-readonly", "package.json"))),
    managedProfileManifest("cognia-sdk-readonly")
  )
})

test("normalizes SDK MCP stdio and HTTP descriptors with strict startup readiness", () => {
  const configs = resolveMcpConfigs(
    JSON.stringify([
      {
        name: "cognia-tools",
        command: process.execPath,
        args: ["bridge.mjs"],
        env: [{ name: "COGNIA_TOOLHOST_TOKEN", value: "fixture" }],
      },
      {
        name: "Remote tools",
        type: "http",
        url: "http://localhost/mcp",
        headers: [{ name: "Authorization", value: "Bearer fixture" }],
      },
    ]),
    "/workspace"
  )
  assert.equal(configs[0].serverName, "cognia-tools")
  assert.equal(configs[0].cwd, "/workspace")
  assert.equal(configs[0].env.COGNIA_TOOLHOST_TOKEN, "fixture")
  assert.equal(configs[0].failOnStartupError, true)
  assert.match(configs[1].serverName, /^Remote_tools_[a-f0-9]{8}$/)
  assert.equal(configs[1].transport, "streamable-http")
  assert.throws(() => resolveMcpConfigs("{}", "/workspace"), /array/)
  assert.throws(
    () =>
      resolveMcpConfigs(JSON.stringify([{ name: "x", command: "node", args: [] }]), "/workspace"),
    /absolute/
  )
  assert.throws(
    () =>
      resolveMcpConfigs(
        JSON.stringify([{ name: "x", type: "sse", url: "https://example.test" }]),
        "/workspace"
      ),
    /transport/
  )
  assert.throws(
    () =>
      resolveMcpConfigs(
        JSON.stringify([{ name: "x", type: "http", url: "file:///tmp/a" }]),
        "/workspace"
      ),
    /HTTP/
  )
  assert.throws(
    () =>
      resolveMcpConfigs(
        JSON.stringify([
          {
            name: "x",
            type: "http",
            url: "http://localhost",
            headers: [
              { name: "A", value: "a" },
              { name: "a", value: "b" },
            ],
          },
        ]),
        "/workspace"
      ),
    /Duplicate/
  )
})

test("Cognia service config enforces scoped MCP and explicit gateway lease", () => {
  const gateway = {
    providers: {
      cognia: {
        api: "openai-completions",
        baseURL: "http://127.0.0.1:1234/v1",
        apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
        models: [{ id: "proxy" }],
      },
    },
  }
  const env = {
    COGNIA_DSH_PROVIDER: "cognia",
    COGNIA_DSH_MODEL: "proxy",
    COGNIA_DSH_GATEWAY_TOKEN: "fixture",
    COGNIA_DSH_GATEWAY_CONFIG: JSON.stringify(gateway),
  }
  assert.deepEqual(resolveCogniaServices(env, "/workspace", "cognia-sdk-readonly").gateway, gateway)
  assert.throws(
    () =>
      resolveCogniaServices(
        { ...env, COGNIA_DSH_GATEWAY_TOKEN: "" },
        "/workspace",
        "cognia-sdk-readonly"
      ),
    /lease/
  )
  assert.throws(
    () =>
      resolveCogniaServices(
        { ...env, COGNIA_DSH_MODEL: "other" },
        "/workspace",
        "cognia-sdk-readonly"
      ),
    /selected model/
  )
  assert.throws(
    () =>
      resolveCogniaServices(
        {
          COGNIA_DSH_MCP_SERVERS: JSON.stringify([
            { name: "x", command: process.execPath, args: [] },
          ]),
        },
        "/workspace",
        "cognia-acp"
      ),
    /session\/new/
  )
  assert.throws(
    () =>
      resolveCogniaServices(
        { COGNIA_DSH_ADDITIONAL_DIRECTORIES: '["relative"]' },
        "/workspace",
        "cognia-sdk-readonly"
      ),
    /absolute/
  )
  assert.deepEqual(
    resolveCogniaServices(
      {
        COGNIA_DSH_ALLOWED_TOOLS: '["read"]',
        COGNIA_DSH_ADDITIONAL_DIRECTORIES: '["/additional"]',
      },
      "/workspace",
      "cognia-sdk-readonly"
    ),
    { mcp: [], gateway: undefined }
  )
})

test("pins one complete DSH release without overriding unrelated infrastructure packages", () => {
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  assert.equal(manifest.dependencies["@deepseek-ai/dsh-llm-deepseek-api-key"], DSH_VERSION)
  for (const [name, version] of Object.entries(manifest.overrides)) {
    assert.match(name, /^@deepseek-ai\/dsh(?:-|$)/)
    assert.equal(version, manifest.dependencies[name] ? `$${name}` : DSH_VERSION)
  }
  for (const name of [
    "dsh-working-directory",
    "dsh-tool-working-directory",
    "dsh-web-deepseek-api",
  ])
    assert.equal(manifest.overrides[`@deepseek-ai/${name}`], DSH_VERSION)
  assert.equal(manifest.overrides["@deepseek-ai/dsh-settings-file"], undefined)
  assert.equal(manifest.overrides["@deepseek-ai/dsh-subagent-in-process-driver"], undefined)
})
