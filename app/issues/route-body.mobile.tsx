"use client"

import { IssuesMobileBody } from "@/components/mobile/issues/issues-mobile-body"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  // Every deep-link parameter, as on the desktop: a phone opening a
  // `?project=` or `?assignee=` link used to land on the unfiltered list.
  return <IssuesMobileBody {...props} />
}
