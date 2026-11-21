/**
 * In-app link to one workflow run's detail page.
 *
 * The app is a static export, so run ids cannot be path segments: the detail
 * page is the single static route `/workflows/run` reading `id` and `runId`
 * from the query string (`app/workflows/run/page.tsx`). The old dynamic
 * `/workflows/<id>/runs/<runId>` route no longer exists, and notifications that
 * still built it opened a 404 on every shell.
 */
export function workflowRunHref(workflowId: string, runId: string): string {
  return `/workflows/run?id=${encodeURIComponent(workflowId)}&runId=${encodeURIComponent(runId)}`
}
