import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { FULL_COMMANDS } from "../../deploy/runner/smoke.mjs"
import { commandsFor, downloadsFor, readRepoInputs } from "./bundle-agent-versions.mjs"

const workflow = readFileSync(
  new URL("../../.github/workflows/images.yml", import.meta.url),
  "utf8"
)

// Keep this release-contract check dependency-free so Images can run it
// before installing the repository's JavaScript workspace dependencies.
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `missing image job ${name}`)
  const rest = workflow.slice(start + 1)
  return rest.slice(0, rest.slice(1).search(/\n  [a-z][a-z-]+:\n/) + 1 || undefined)
}

test("Runner profiles build from the root and promote only smoke-tested digests", () => {
  assert.doesNotMatch(job("fast-images"), /name: cognia-runner/)
  const runner = job("runner-image")
  assert.match(runner, /variant: \[full, codex\]/)
  assert.match(runner, /node --test[^\n]*deploy\/runner\/install-selected\.test\.mjs/)
  assert.match(runner, /context: \.\n/)
  assert.match(runner, /target: .*'selected'.*'full'/)
  assert.match(runner, /build-args: AGENT_RUNTIMES=codex-acp,codex-app-server/)
  assert.match(runner, /outputs: .*push-by-digest=true/)
  const smokeIndex = runner.indexOf("node deploy/runner/smoke.mjs")
  const promoteIndex = runner.indexOf("docker buildx imagetools create")
  assert.ok(smokeIndex > runner.indexOf("id: build"))
  assert.ok(promoteIndex > smokeIndex)
  assert.match(runner.slice(smokeIndex), /\^sha256:/)
  assert.match(runner, /flavor: .*codex/)
  assert.match(runner, /value=latest,/)
  assert.match(runner, /value=latest-full,/)
})

test("Bundle profiles smoke each native architecture and keep tested digests separate", () => {
  const bundle = job("agent-bundle")
  assert.match(bundle, /variant: \[full, codex\]/)
  assert.match(bundle, /arch: \[amd64, arm64\]/)
  assert.match(bundle, /arch: amd64\s+platform: linux\/amd64\s+runner: ubuntu-latest/)
  assert.match(bundle, /arch: arm64\s+platform: linux\/arm64\s+runner: ubuntu-24.04-arm/)
  assert.match(bundle, /AGENT_RUNTIMES=.*matrix.variant.*codex-acp,codex-app-server/)
  assert.match(bundle, /outputs: .*push-by-digest=true/)
  const smokeIndex = bundle.indexOf("sh deploy/bundle/smoke.sh")
  const recordIndex = bundle.indexOf("name: Record tested platform digest")
  assert.ok(smokeIndex > bundle.indexOf("id: build"))
  assert.ok(recordIndex > smokeIndex)
  assert.match(bundle, /name: agent-bundle-digest-.*matrix.variant.*matrix.arch/)
  assert.match(bundle, /path: .*agent-bundle-digests\/.*matrix.variant.*matrix.arch/)
  const publish = job("agent-bundle-manifest")
  assert.match(publish, /needs: \[vars, agent-bundle\]/)
  assert.match(publish, /variant: \[full, codex\]/)
  assert.match(publish, /flavor: .*codex/)
  assert.match(publish, /pattern: agent-bundle-digest-.*matrix.variant/)
  assert.match(publish, /\$DIGEST_DIR\/\$VARIANT-\$arch.txt/)
})

test("Image profile and smoke inputs trigger pull request image validation", () => {
  for (const path of [
    "scripts/build/agent-image-profiles.test.mjs",
    "scripts/build/bundle-agent-versions*.mjs",
  ]) {
    assert.ok(workflow.includes(`- "${path}"`), path)
  }
})

test("selected Runner binds native npm from its final custom base before publishing wrapper PATH", () => {
  const dockerfile = readFileSync(
    new URL("../../deploy/runner/Dockerfile", import.meta.url),
    "utf8"
  )
  const selected = dockerfile.slice(
    dockerfile.indexOf("FROM base AS selected"),
    dockerfile.indexOf("FROM base AS full")
  )
  assert.match(selected, /COGNIA_NATIVE_NPX="\$\(command -v npx \|\| true\)"/)
  assert.match(selected, /\/cognia\/glibc\/node\/bin\/node .* configure-base/)
  assert.ok(selected.indexOf("configure-base") < selected.indexOf("ENV PATH="))
  const builder = dockerfile.slice(
    dockerfile.indexOf("AS selected-build"),
    dockerfile.indexOf("FROM ${RUNTIME_IMAGE}")
  )
  assert.ok(builder.indexOf("COPY deploy/runner/install-selected.mjs") > builder.indexOf("npm ci"))
})

test("Both Runner targets end as uid 10001 with a home of their own", () => {
  const dockerfile = readFileSync(
    new URL("../../deploy/runner/Dockerfile", import.meta.url),
    "utf8"
  )
  for (const target of ["selected", "full"]) {
    const start = dockerfile.indexOf(`FROM base AS ${target}`)
    const next = dockerfile.indexOf("\nFROM ", start + 1)
    const stage = dockerfile.slice(start, next === -1 ? undefined : next)
    const users = [...stage.matchAll(/^USER (\S+)$/gm)].map((match) => match[1])
    assert.equal(users.at(-1), "10001:10001", `${target} ends as the Runner user`)
    assert.match(stage, /HOME=\/home\/cognia/)
  }
  assert.match(dockerfile, /useradd --uid 10001 --gid 10001 --home-dir \/home\/cognia/)
  assert.match(dockerfile, /ARG INSTALL_CURSOR_AGENT=0/)
})

// A prerelease tag (v2.1.0-beta.1) produced latest, latest-full and
// latest-codex like a release, so deployments following them got the beta.
test("Only a stable release tag moves the latest tags", () => {
  const vars = job("vars")
  assert.match(vars, /stable_release: \$\{\{ steps\.o\.outputs\.stable_release \}\}/)
  assert.match(vars, /"\$GITHUB_REF" == refs\/tags\/v\* && "\$GITHUB_REF_NAME" != \*-\*/)
  const rules = [...workflow.matchAll(/type=raw,value=latest[^\n]*/g)].map((match) => match[0])
  assert.ok(rules.length >= 8, `found ${rules.length} latest rules`)
  for (const rule of rules) {
    assert.match(rule, /needs\.vars\.outputs\.stable_release == 'true'/, rule)
    assert.doesNotMatch(rule, /startsWith\(github\.ref/, rule)
  }
})

test("Every pushed image carries SBOM and max-level provenance attestations", () => {
  const steps = workflow.split(/\n(?=\s+- (?:name:|uses:|id:))/)
  const builds = steps.filter(
    (step) =>
      step.includes("docker/build-push-action") &&
      /push: \$\{\{ needs\.vars\.outputs\.should_push|push=true/.test(step)
  )
  assert.ok(builds.length >= 6, `found ${builds.length} pushing builds`)
  for (const step of builds) {
    assert.match(step, /\n\s+sbom: \$\{\{ needs\.vars\.outputs\.should_push == 'true'/, step)
    assert.match(step, /\n\s+provenance: \$\{\{ needs\.vars\.outputs\.should_push == 'true'.*'mode=max'/, step)
  }
})

/** One `FROM … AS <name>` stage of the Runner Dockerfile, up to the next stage. */
function runnerStage(dockerfile, name) {
  const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, "m"))
  assert.ok(start >= 0, `missing stage ${name}`)
  const next = dockerfile.indexOf("\nFROM ", start + 1)
  return dockerfile.slice(start, next === -1 ? undefined : next)
}

// Full used a global `npm install -g` that pinned only the top-level
// versions, so a rebuild could pull different transitive dependencies.
test("Full builds the locked tree of every runtime by the selected steps", () => {
  const dockerfile = readFileSync(
    new URL("../../deploy/runner/Dockerfile", import.meta.url),
    "utf8"
  )
  const steps = (stage) =>
    stage
      .split("\n")
      .slice(1)
      .filter((line) => !/^ARG AGENT_RUNTIMES=/.test(line))
      .join("\n")
      .replace('--runtimes "$AGENT_RUNTIMES"', "--runtimes <selection>")
      .replace("--runtimes full", "--runtimes <selection>")
      .replace("install-selected.mjs install-compat ", "install-selected.mjs install ")
      .trim()
  const selected = runnerStage(dockerfile, "selected-build")
  const full = runnerStage(dockerfile, "full-build")
  assert.match(full, /--runtimes full /)
  assert.match(full, /install-selected\.mjs install-compat /)
  assert.equal(steps(full), steps(selected))

  const target = runnerStage(dockerfile, "full")
  assert.match(target, /^COPY --from=full-build \/cognia \/cognia$/m)
  assert.doesNotMatch(dockerfile, /npm install -g|install-agents\.sh/)
  // Versions come only from the pins (no per-Agent build-arg overrides).
  assert.doesNotMatch(dockerfile, /^ARG (?!NODE_VERSION=)[A-Z_]+_VERSION=/m)
  assert.match(
    target,
    /if \[ "\$INSTALL_CURSOR_AGENT" = "1" \]; then bash \/tmp\/install-cursor-agent\.sh; fi/
  )
  assert.match(target, /PATH="\/cognia\/runner\/bin:\/cognia\/glibc\/bin:/)
})

test("The Full command list is the pins' glibc commands and vendor binaries", () => {
  const { pins } = readRepoInputs()
  const expected = new Set(commandsFor(pins, "glibc").map((command) => command.name))
  for (const download of downloadsFor(pins, "glibc", "amd64")) expected.add(download.command)
  assert.deepEqual([...FULL_COMMANDS].sort(), [...expected].sort())
})
