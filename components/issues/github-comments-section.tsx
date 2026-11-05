"use client"

import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

/**
 * The GitHub conversation of an issue, read on demand.
 *
 * Collapsed until asked for: a read costs API quota and the panel opens for
 * every card a person clicks, so the comments load only when the person wants
 * them. Bodies render as plain text — they are third-party content — with
 * only issue identifiers linked, and only to in-app addresses (D25).
 */

import Link from "next/link"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, MessagesSquareIcon, RefreshCwIcon } from "lucide-react"

import { InlineLinkedText } from "@/components/chat/inline-linked-text"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { fetchGithubIssueComments, type GithubIssueComments } from "@/lib/issues/github-comments"
import { isMissingGithubCredential } from "@/lib/issues/sync-runner"
import { connectionsHref } from "@/lib/settings/deep-link"

export interface GithubCommentsSectionProps {
  target: { repoFullName: string; number: number }
  /** Seam for tests; production reads through the shared GitHub credential. */
  load?: typeof fetchGithubIssueComments
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; result: GithubIssueComments }
  | { status: "error"; noCredential: boolean }

export function GithubCommentsSection({
  target,
  load = fetchGithubIssueComments,
}: GithubCommentsSectionProps) {
  const t = useTranslations("issues")
  const [state, setState] = useState<State>({ status: "idle" })

  async function read() {
    setState({ status: "loading" })
    try {
      setState({
        status: "loaded",
        result: await load(target, undefined, { localAuthorization: LOCAL_PERSON_RUN }),
      })
    } catch (cause) {
      setState({ status: "error", noCredential: isMissingGithubCredential(cause) })
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="issue-github-comments">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("githubComments.section")}
        </h3>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={state.status === "loading"}
          onClick={() => void read()}
          data-testid="issue-github-comments-load"
        >
          {state.status === "idle" ? (
            <MessagesSquareIcon className="size-3.5" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          {state.status === "idle" ? t("githubComments.load") : t("githubComments.refresh")}
        </Button>
      </div>

      {state.status === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("githubComments.loading")}</p>
      ) : null}

      {state.status === "error" && state.noCredential ? (
        // Nothing this view may use can read the repository (D22): say which,
        // and lead to where a credential is connected. Refresh retries.
        <div
          role="alert"
          data-testid="issue-github-comments-no-credential"
          className="flex flex-col items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
        >
          <p>{t("githubComments.noCredential", { repository: target.repoFullName })}</p>
          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
            <Link href={connectionsHref()}>{t("githubComments.openConnections")}</Link>
          </Button>
        </div>
      ) : null}
      {state.status === "error" && !state.noCredential ? (
        <p className="text-xs text-destructive" role="alert">
          {t("githubComments.failed")}
        </p>
      ) : null}

      {state.status === "loaded" ? (
        state.result.comments.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("githubComments.empty")}</p>
        ) : (
          <ol className="flex flex-col gap-2" data-testid="issue-github-comments-list">
            {state.result.comments.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-0.5 text-xs">
                <span className="flex items-center gap-1 text-muted-foreground">
                  {comment.authorIsBot ? <BotIcon className="size-3" aria-hidden /> : null}
                  <span className="font-medium text-foreground">
                    {comment.author || t("githubComments.unknownAuthor")}
                  </span>
                  {comment.createdAt ? (
                    <time dateTime={new Date(comment.createdAt).toISOString()}>
                      {new Date(comment.createdAt).toLocaleString()}
                    </time>
                  ) : null}
                  {comment.updatedAt > comment.createdAt ? (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      {t("githubComments.edited")}
                    </Badge>
                  ) : null}
                  {comment.url ? (
                    <a
                      href={comment.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-auto text-primary underline-offset-4 hover:underline"
                    >
                      {t("githubComments.open")}
                    </a>
                  ) : null}
                </span>
                <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 text-sm">
                  <InlineLinkedText text={comment.body} />
                </p>
              </li>
            ))}
            {state.result.truncated ? (
              <li className="text-xs text-muted-foreground">{t("githubComments.truncated")}</li>
            ) : null}
          </ol>
        )
      ) : null}
    </section>
  )
}
