/** @jest-environment node */
/**
 * ADR-0243 acceptance: every attack scenario the ADR names before phases 4
 * and 5 ship, and the delegated lane's own cases, each pointing at the test
 * that runs it. This suite checks each pointer against the source of the test
 * it names, so a renamed or deleted test fails here instead of leaving a
 * scenario silently uncovered. A scenario not yet fully covered says so in
 * `residual`, with the nearest test and what is missing.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

interface Pointer {
  /** Repository-relative test file. */
  file: string
  /** The test's title exactly as written (a Rust test's function name). */
  title: string
}

interface Scenario {
  name: string
  covered: Pointer[]
  /** What the covering tests do not yet run, when anything. */
  residual?: string
}

const SCENARIOS: Scenario[] = [
  {
    name: "1. a steer by a second person",
    covered: [
      {
        file: "lib/execution/personal-visibility.test.ts",
        title:
          "a second person's steer withholds the previous answer, including through a live child's root",
      },
    ],
  },
  {
    name: "2. a child laundering a personal read",
    covered: [
      {
        file: "lib/execution/personal-sink.test.ts",
        title:
          "reads every structural ancestor, so a pre-existing child cannot launder a later parent read",
      },
    ],
  },
  {
    name: "3. a repeat request from a later turn",
    covered: [
      {
        file: "lib/execution/personal-visibility.test.ts",
        title:
          "a later request cannot repeat the previous person's answer or launder a child's read",
      },
    ],
  },
  {
    name: "4. a summary written to a shared document",
    covered: [
      {
        file: "lib/execution/personal-sink.test.ts",
        title:
          "withholds document writes with exact content hash and original target in an unindexed receipt",
      },
    ],
    residual: "Sink level only. A Lark CLI document write from a marked run is not run end to end.",
  },
  {
    name: "5. operator sharing",
    covered: [
      {
        file: "lib/connectors/personal-delivery.test.ts",
        title: "withholds two people's content and does not treat operator approval as disclosure",
      },
    ],
  },
  {
    name: "6. a revoked binding while a run is parked",
    covered: [
      {
        file: "lib/auth-providers/feishu/authed-api.test.ts",
        title: "refuses the next call after the person's authorization is revoked mid-run",
      },
      {
        file: "lib/connectors/adapters/lark/delegated-credentials.test.ts",
        title: "disconnects at the current epoch and drops only that person's record",
      },
    ],
  },
  {
    name: "7. a parallel-children budget",
    covered: [
      {
        file: "lib/execution/run-ledger.test.ts",
        title: "reserves an execution's own cap so capped siblings run side by side",
      },
    ],
    residual: "Ledger level only. Parallel children at the executor are not run.",
  },
  {
    name: "8. token export to an external CLI",
    covered: [
      {
        file: "lib/execution/personal-credential.test.ts",
        title: "never exports personal OAuth credentials to an external engine",
      },
      {
        file: "crates/cognia-exec-sandbox/src/bin/cognia-external-agent-launcher.rs",
        title: "an_isolated_scope_blocks_keychain_ipc",
      },
    ],
  },
  {
    name: "9. a Lark direct chat without ephemeral support",
    covered: [
      {
        file: "lib/connectors/personal-delivery.test.ts",
        title:
          "uses a verified owner's direct message when ephemeral is unavailable, stripping original routes",
      },
      {
        file: "lib/connectors/personal-delivery.test.ts",
        title:
          "direct-messages the marked person of this adapter themself, never another adapter's",
      },
    ],
  },
  {
    name: "10. a resumed engine session after a second requester joins",
    covered: [
      {
        file: "lib/ai/agent/external/manager.test.ts",
        title:
          "gives a second requester a new key and a fresh session, and drops the first's state",
      },
    ],
  },
  {
    name: "11. old history in a migrated conversation",
    covered: [
      {
        file: "lib/execution/personal-visibility.test.ts",
        title:
          "desktop owner sees migrated Lark history while a non-owner cannot see legacy attribution",
      },
    ],
  },
  {
    name: "12. a bound-person read triggered by someone else",
    covered: [
      {
        file: "lib/execution/personal-disclosure.test.ts",
        title:
          "refuses bound-person disclosure until phase 5 supplies declared-recipient authority",
      },
    ],
    residual: "The bound-person lane is phase 5; until then its disclosure is refused.",
  },
  {
    name: "13. a webhook against a delegated installation",
    covered: [
      {
        file: "lib/auth-providers/feishu/cli/auth-bridge.test.ts",
        title:
          "selects the external-event service lane without personal admission, and refuses explicit user identity",
      },
      {
        file: "lib/execution/personal-credential.test.ts",
        title: "never admits an IM run outside the delegated lane",
      },
    ],
  },
  {
    name: "14. shell egress after a disclosure",
    covered: [
      {
        file: "lib/execution/personal-egress.test.ts",
        title: "checks live taint per call and keeps search available",
      },
    ],
  },
  {
    name: "15. a summary written to a document the person owns but shares",
    covered: [
      {
        file: "lib/execution/personal-sink.test.ts",
        title:
          "withholds document writes with exact content hash and original target in an unindexed receipt",
      },
    ],
    residual:
      "Ownership never proves a document's audience (every document write is `unknown`), so the sink withholds; a write the person owns but shares is not run end to end.",
  },
  {
    name: "16. an unmetered engine under a finite budget",
    covered: [
      {
        file: "lib/ai/agent/external/manager.test.ts",
        title: "refuses a native engine that reports no usage under a token or dollar hold, free",
      },
    ],
  },
  {
    name: "delegated: a non-owner's turn uses only their own authorization",
    covered: [
      {
        file: "lib/auth-providers/feishu/cli/acting-identity.test.ts",
        title: "uses the acting person's own authorization, admitted as that person",
      },
      {
        file: "lib/connectors/adapters/lark/index.test.ts",
        title: "sends %s as the bot, never reading the owner's authorization",
      },
    ],
  },
  {
    name: "delegated: a link opened by someone else is refused at the callback",
    covered: [
      {
        file: "lib/auth-providers/feishu/oauth-handler.test.ts",
        title: "refuses a link opened by someone else before writing anything",
      },
    ],
  },
  {
    name: "delegated: a revoked person is refused on the next call",
    covered: [
      {
        file: "lib/auth-providers/feishu/authed-api.test.ts",
        title: "refuses the next call after the person's authorization is revoked mid-run",
      },
      {
        file: "lib/auth-providers/feishu/auth.test.ts",
        title: "does not refresh a revoked access identity even if its refresh token remains",
      },
    ],
  },
  {
    name: "delegated: two people authorize concurrently",
    covered: [
      {
        file: "lib/auth-providers/feishu/oauth-pending.test.ts",
        title: "keeps several sign-ins on one adapter apart",
      },
    ],
  },
  {
    name: "delegated: a requester without authorization gets a link only they can complete",
    covered: [
      {
        file: "lib/auth-providers/feishu/cli/acting-identity.test.ts",
        title: "gets their own link as a delivery of this turn",
      },
      {
        file: "lib/connectors/delegated-authorization.test.ts",
        title: "sends the link as the marked turn's own delivery, narrowed to that person",
      },
    ],
  },
  {
    name: "delegated: an engine turn carrying only the requester's own content",
    covered: [
      {
        file: "lib/ai/agent/external/policy/launch-profile.test.ts",
        title: "holds for a delegated requester whose every mark names them",
      },
      {
        file: "lib/ai/agent/external/policy/launch-profile.test.ts",
        title: "fails for another person's content, unverified marks, or none",
      },
    ],
  },
]

const root = join(__dirname, "..", "..")
const sources = new Map<string, string>()
function source(file: string): string {
  let text = sources.get(file)
  if (text === undefined) {
    text = readFileSync(join(root, file), "utf8")
    sources.set(file, text)
  }
  return text
}

describe.each(SCENARIOS)("$name", ({ covered }) => {
  it.each(covered)("is run by $file: $title", ({ file, title }) => {
    const text = source(file)
    const named = file.endsWith(".rs")
      ? new RegExp(`fn ${title}\\s*\\(`).test(text)
      : text.includes(`"${title}"`) || text.includes(`'${title}'`) || text.includes(`\`${title}\``)
    expect(named).toBe(true)
  })
})

it("names every scenario the ADR lists, in order", () => {
  expect(
    SCENARIOS.filter((scenario) => /^\d+\./.test(scenario.name)).map((scenario) =>
      Number.parseInt(scenario.name, 10)
    )
  ).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
})

it("keeps the open residuals explicit", () => {
  expect(
    SCENARIOS.filter((scenario) => scenario.residual).map((scenario) => scenario.name)
  ).toEqual([
    "4. a summary written to a shared document",
    "7. a parallel-children budget",
    "12. a bound-person read triggered by someone else",
    "15. a summary written to a document the person owns but shares",
  ])
})
