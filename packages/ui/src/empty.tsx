// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./utils"

/** Centered empty-state container; fills its flex parent and dashes a border when given one. */
function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border-dashed p-6 text-center text-balance md:p-12",
        className,
      )}
      {...props}
    />
  )
}

/** Groups the empty state's media, title, and description. */
function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn(
        "flex max-w-sm flex-col items-center gap-2 text-center",
        className,
      )}
      {...props}
    />
  )
}

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

/** The empty state's icon/illustration; `variant="icon"` renders a muted rounded tile. */
function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      {...props}
    />
  )
}

/** The empty state's headline. */
function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn("text-lg font-medium tracking-tight", className)}
      {...props}
    />
  )
}

/** Supporting copy under the title; styles any nested links. */
function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  )
}

/** Holds the empty state's actions (e.g. a CTA button) below the header. */
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The whole empty state in one call — the shape every page actually wanted.
 *
 * The parts above have existed and been used in four places, while SIX more empty states were
 * written locally across the console, two of them near-identical `EmptyState({canManage, action})`
 * in sibling files. The parts were not the problem; the absence of a composed default was, because
 * assembling five components correctly is more work than writing a div.
 *
 * This is a convenience OVER the parts, not a replacement for them: anything needing a different
 * arrangement still composes `Empty` + `EmptyHeader` + … directly, and existing callers are
 * untouched.
 */
function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  /** A lucide icon element, rendered in a muted tile. Omit for a text-only state. */
  icon?: React.ReactNode
  /** What is not here — a noun phrase ("No runners yet"), not a sentence. */
  title: React.ReactNode
  /** Why it is empty, or what to do about it. One line. */
  description?: React.ReactNode
  /** The single next step, usually a Button. Omit when the viewer cannot act. */
  action?: React.ReactNode
}) {
  return (
    <Empty className={className} {...props}>
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

export {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
  EmptyState,
}
