// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button as ButtonPrimitive } from "@base-ui-components/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

import { cn } from "./utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-none text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        // Single-use: the "Start free trial" conversion CTA only. The one
        // sanctioned hue on an otherwise grayscale system — do not reuse.
        cta: "bg-cta text-cta-foreground hover:bg-cta-hover focus-visible:ring-cta/40",
        destructive:
          "border border-border bg-transparent text-foreground shadow-xs hover:border-foreground hover:bg-[var(--signal-critical-surface)] focus-visible:ring-ring/50",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-none px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-none px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-none px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-none [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** Public Button surface: the familiar native-`<button>` props plus base-ui's `render` /
 * `nativeButton` opt-ins. We deliberately present this stable shape instead of base-ui's raw
 * native|non-native union — the union can't be spread cleanly and types events as `BaseUIEvent`,
 * which would ripple type errors into every consumer that re-spreads Button props or types an
 * `onClick`. Consumers keep the standard React surface; base-ui's extras stay available. */
type ButtonProps = React.ComponentProps<"button"> &
  Pick<ButtonPrimitive.Props, "render" | "nativeButton"> &
  VariantProps<typeof buttonVariants>

/** Grayscale/squared button. Migrated off Radix `Slot` to the base-ui `Button` primitive: pass a
 * `render` prop (base-ui's `asChild` replacement, e.g. `render={<Link href="…" />}`) to render as a
 * different element; the button's children merge into it. `nativeButton={false}` when rendering a
 * non-`<button>` element (e.g. an anchor). base-ui's Button is itself a client component, so this
 * wrapper stays server-compatible. */
function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
