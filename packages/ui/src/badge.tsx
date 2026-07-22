"use client"
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { mergeProps } from "@base-ui-components/react/merge-props"
import { useRender } from "@base-ui-components/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-none border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-border bg-[var(--signal-critical-surface)] text-foreground [a&]:hover:border-foreground focus-visible:ring-ring/50",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/** Grayscale/squared badge. Migrated off Radix `Slot` to the base-ui `useRender` hook: pass a
 * `render` prop (base-ui's `asChild` replacement, e.g. `render={<a href="…" />}`) to render as a
 * different element; the badge's props merge into it via `mergeProps`. `useRender` is a hook, so
 * this module is a client component — the exported `badgeVariants` cva still imports cleanly into
 * Server Components. */
function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  // `data-slot` is a valid JSX data-attribute but not a member of the typed
  // `InputProps<"span">` literal, so it must be supplied via a variable (extra
  // props are allowed structurally) rather than a fresh literal (excess-checked).
  const ownProps = {
    "data-slot": "badge",
    className: cn(badgeVariants({ variant }), className),
  }
  return useRender({
    defaultTagName: "span",
    render,
    props: mergeProps<"span">(ownProps, props),
  })
}

export { Badge, badgeVariants }
