---
title: "0254 — A playbook is a skill that compiles to a workflow"
description: "Cognia ships its default engineering processes as playbooks: skills assembled from other skills, with an optional references/flow.yaml that compiles deterministically into a read-only VisualWorkflow. The quality patterns become building-block skills backed by one pattern core that no longer needs a Squad. The engine (pattern core, changeset gate, verifier prompts) stays in the host; the content (playbooks, Squad templates, commands, Bot definitions) lives in a first-party plugin. Launches show a cost estimate and stop at a budget."
---

# ADR 0254 — A playbook is a skill that compiles to a workflow

**Status:** Proposed
**Date:** 2026-11-07

**Related:**
- [ADR-0022](./0022-agent-team-runtime-hardening) (Ultracode addendum): the six quality patterns. Amended.
- [ADR-0252](./0252-a-room-talks-a-squad-works-a-delegation-promises): `startSquadRun` and `launchChildRun` are the only ways to start a Squad or a child run. Playbooks use them.
- [ADR-0227](./0227-agent-changes-integrate-through-one-host-queue): the changeset review gate this ADR extends.
- [ADR-0070](./0070-risk-ceremony-policy-layer): risk tiers decide how much review a change gets.
- [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched): a playbook run scopes its sub-skills and budget through a grant.
- [ADR-0232](./0232-a-long-run-shows-an-estimate-never-a-budget): the estimate shown before launch. It stays advisory.
- [ADR-0100](./0100-unified-template-platform): Squad templates reach the picker through the template catalog.

**Evidence:** design `docs/plans/2026-11-07-default-flows.md` (grilled over five rounds, decisions in §4.1–4.5) and implementation plan `docs/plans/2026-11-07-playbooks-implementation.md` §0, both on `dev` at `7775a703b5`.

## Context

Cognia has most of the parts of a good engineering process and none of the processes.

- **Patterns exist but only one caller can use them.** The six quality patterns (sweep, loop-until-dry, adversarial verify, judge panel, completeness critic, synthesize) run only inside a Squad's ultracode run. They look up a `TeamRunContext` by run id and throw without one. They are hidden in the workflow editor, and an LLM planner chooses their composition fresh on every run, so no process can pin one.
- **Review exists four times.** The per-file diff hint (`lib/git/ai-review.ts`), the changeset gate (`lib/scm/review/review-agent.ts`), the Squad PR reviewer (`lib/squads/pr-feedback/reviewer.ts`) and the lead task review (ADR-0071) each review on their own. The gate reviews one file at a time with one lens and never checks whether a finding is real.
- **Templates are rosters.** Eight built-in Squad templates list teammates and nothing else: no patterns, no isolation, no trigger, no output.
- **Skills cannot compose.** A skill reaches another only through free text asking the model to call `load_skill`, which fails if the target is outside the send's scope.

An external catalogue of about 170 single-role subagents prompted the question of which processes Cognia should offer by default. Its value is in a few working methods (refute every finding before reporting it; fix documentation only from a diff), not in the number of roles. Language-specialist and meta-orchestration roles duplicate the base model and Cognia's own runtime.

## Decision

### 1. A playbook is a skill

A **playbook** (中文：流程) is a skill that composes other skills. Its `SKILL.md` stays standard so other tools can read it. It may carry a structured step list at **`references/flow.yaml`**. That path survives built-in packaging, the disk mirror and the native scan unchanged, and `load_skill_resource` already serves it.

`flow.yaml` (version 1) declares inputs, steps and limits. A step `uses` one of: `skill:<id>`, `pattern:<kind>`, `squad:<templateId>`, `playbook:<skillId>`, `approval`, `issue.*`, `notify`. Steps declare dependencies, parallelism, `requiresTools` and human confirmation. Limits cap sub-agents, fan-out and spend.

### 2. Two ways to run one definition

- **As a skill.** An agent follows the playbook in chat or a room. The skills it references enter the run's scope through the grant's `skills.add`, and `limits.maxBudgetUsd` becomes the grant's `maxBudgetUsd`. Steps that write code start a Squad through `startSquadRun`.
- **As a workflow.** `flow.yaml` compiles deterministically into a `VisualWorkflow`: the same input gives the same graph. The graph is **derived**: it records `derivedFrom` (skill id, content hash) and is `readOnly`, and it is recompiled when the skill changes. A person who wants to edit the graph **detaches** it into an ordinary workflow that no longer follows the skill. A skill without `flow.yaml` can still be turned into a workflow by the editor's AI drafting, reviewed by a person, and saved as an ordinary workflow.

In workflow mode, a playbook that calls another is compiled with the called playbook **inlined** under the calling step, and the called playbook's text feeds the content hash. `flow.subworkflow` is not used: it runs only a published workflow, and a derived workflow is never published. The compiler rejects call cycles. A playbook with a `sensitive` input does not compile, because a workflow run stores its inputs in run history; it runs as a skill.

### 3. Patterns are building-block skills with one core

Each pattern is also a building-block skill. In skill mode an agent runs it with sub-agents. In workflow mode it compiles to its `pattern.*` node.

The node executors become thin shells over a **pattern core** in `lib/squads/patterns/core/`, listed in the squads module's `api`. The core depends on one injected port: run one structured step (prompt, Zod schema, `requiresTools`, signal), a fan-out width, a prompt context and an optional synthesis callback. The port has three implementations: a Squad teammate (today's behaviour), a workflow model call, and a plain `LlmClient`. **An implementation without tools refuses a step that requires them.** The `repro` lens cannot silently lose its reproduction ability. The pattern nodes become placeable in the editor.

Verifier lenses gain `architecture` and `tests`.

### 4. The engine stays in the host; the content ships as a plugin

- **Host:** the pattern core, the verifier prompts, the composition the changeset gate uses, the review policy, the `flow.yaml` schema and compiler (`lib/skills/playbook/`), and launch, estimate and settings glue (`lib/playbooks/`).
- **Plugin `plugins/cognia-playbooks`, enabled by default:** playbook and building-block skills, the eight built-in Squad templates (moved out of the contract package; `builtin.agentTeam.<id>` resolves to them), slash commands and Bot definitions.

Disabling the plugin removes playbooks, templates and commands. It does not change the changeset gate. The plugin can later move to the cognia-plugins repository with the rest of `plugins/`.

A Squad template is a playbook's execution configuration: roster, isolation and integration settings, and the skills its teammates use. Its ultracode composition comes from a playbook (`ultracode.playbookSkillId`); the planner runs only when none is given.

### 5. The changeset gate reviews by risk tier and refutes before it blocks

The gate passes the change's risk tier to review.

- **Low tier:** today's per-file review, refuting only high and critical findings.
- **Medium and high tiers:** the full composition. Four lenses sweep; the top 15 findings at medium or above are refuted by three skeptics each; the rest are reported as unverified and do not count toward the verdict.
- **A critical finding that the majority refutes still needs a person.** The verdict becomes "needs human approval", carrying the refutation. Refutation removes noise but never loosens the gate.

`unavailable` keeps its meaning: no model, an unparseable reply or an incomplete review owes a person. The Squad PR reviewer moves onto the same core. The lead task review uses it only when the task's output is a changeset.

### 6. Cost is visible before launch and bounded during the run

- **The estimate is shown, never enforced (ADR-0232 unchanged).** Every manual launch of a playbook, a Squad or a workflow shows an estimate. A skill-mode estimate is computed from `flow.yaml` and labelled as an estimate. No estimate asks for confirmation or stops a run.
- **Spend is bounded by budgets, not estimates:**
  - Squads keep `RunBudgetGovernor`.
  - Skill mode carries the grant's `maxBudgetUsd`.
  - Workflow runs gain a USD cap (`WorkflowSettings.maxCostUsd`), counted from the usage ledger. The cap is a new budget, not an estimate.
  - Counting rule (decided 2026-11-07): a step's reported cost, and any usage a model's pricing table can price, count against the cap. A step whose spend cannot be priced, or a model-calling step that reports no usage, does not stop the run; the run log and the run summary mark it "not covered by the budget". This differs on purpose from the chat quota, which refuses unknown cost: a workflow runs unattended, and refusing would fail runs whose cost is simply not measurable.
  - A sub-workflow inherits what its parent has left and charges its spend to the parent.
- A run that reaches its budget stops: steps in flight are aborted, no further step starts, and the run fails with `budget_exhausted` through the normal failure path (catch nodes, failure notification, completion fan-out), whatever its error policy says.
- Scheduled playbooks are off by default. A person enables one from its card through the scheduler form, which keeps the scheduler's confirmation rule for agent tasks.

### 7. Where playbooks appear

- Chat and rooms: `/review`, `/debug`, `/research`, composer suggestions, ⌘K.
- The Squad panel and the template center, where playbooks are a filtered view of the skill domain (no new template domain).
- The workflow library and editor.
- Automation: the scheduler, Bot definitions, Issue runs and the changeset gate.

The English name is **Playbooks**. "Flows" is taken by the browser recorder's saved flows.

## Consequences

- **One process, one definition.** A playbook started from chat, a Squad template or the workflow library runs the same steps.
- **Review gets stricter at medium risk and quieter at low risk.** Medium and high changes pay for a fuller review. Low-risk changes cost about what they do today.
- **Patterns become reusable outside Squads.** That includes user-built workflows, so a workflow USD cap and a workflow estimate surface become prerequisites rather than extras.
- **Contract changes.** `VisualWorkflow.derivedFrom` / `readOnly`, `WorkflowSettings.maxCostUsd` and `ultracode.playbookSkillId` change `packages/plugin-contract` and require rebuilding the authoring kit.
- **The Squad template picker reads the template catalog.** Built-in templates appear only after the catalog boots, so the picker gains a loading state.
- **Two run modes can disagree.** Skill mode lets the agent choose its fan-out, so its results and cost vary more. Scheduled and audit-bound uses default to workflow mode.
- **Sequencing.** The pattern core and the `action.team.run` changes land after ADR-0252's P5, which also edits `judge-panel.ts` and `action.team.run`.

## Amends

- **ADR-0022 (Ultracode addendum).**
  - The patterns run on a core that no longer needs a Squad.
  - A Squad template's composition comes from a playbook. The planner remains for runs without one.
  - Lenses gain `architecture` and `tests`.
  - `repro` requires tools and is refused where none exist.
  - The pattern nodes are placeable in the editor.
