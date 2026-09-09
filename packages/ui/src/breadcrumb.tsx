"use client"
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { mergeProps } from "@base-ui-components/react/merge-props"
import { useRender } from "@base-ui-components/react/use-render"
import { ChevronRight, MoreHorizontal } from "lucide-react"
import * as React from "react"

import { cn } from "./utils"

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-sm break-words text-muted-foreground sm:gap-2.5",
        className
      )}
      {...props}
    />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  )
}

function BreadcrumbLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    render,
    props: {
      ...mergeProps<"a">(
        { className: cn("transition-colors hover:text-foreground", className) },
        props,
      ),
      "data-slot": "breadcrumb-link",
    },
  })
}

/**
 * The trail's CURRENT page. It is a `<span aria-current="page">` and nothing more.
 *
 * IT USED TO CARRY `role="link"` + `aria-disabled="true"` — upstream shadcn's shape, which models
 * the crumb as a link that has been switched off. It is not a link: it navigates nowhere, it takes
 * no focus, and there is no href behind it. The cost was not theoretical. The console paints this
 * bar on every route inside the shell, and the crumb's label is by construction the label of the
 * page you are on — which is also the label of the sidebar row that got you there. So every
 * `getByRole("link", { name: "Jobs" })` in the app resolved to TWO nodes, the real navigation
 * control and this one, and Playwright's strict mode refused the locator before any assertion ran:
 * 19 of `flows/navigation-shell.spec.ts`'s tests failed on it, and `helpers/shell.ts` exists to
 * scope around it (#4267).
 *
 * `aria-current="page"` is the whole accessible statement a current crumb has to make, and a
 * screen reader announces it from a bare span. `aria-disabled` went with the role: it is not an
 * allowed attribute on a generic element, so keeping it would trade one defect for an axe finding.
 */
function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      aria-current="page"
      className={cn("font-normal text-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  )
}

function BreadcrumbEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More</span>
    </span>
  )
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
}
