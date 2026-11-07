/**
 * Where "Open as workflow" on a skill goes (ADR-0254 §2). The workflow
 * editor's route compiles a playbook, or starts a Copilot draft for any other
 * skill, then moves to the workflow's own `?id=`. A plain link, so the skill
 * views need no import from the workflow side.
 */
export function playbookWorkflowHref(skillId: string): string {
  return `/workflows/editor?playbook=${encodeURIComponent(skillId)}`
}
