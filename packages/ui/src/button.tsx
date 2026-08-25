// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* This renders base-ui's Button, which is itself a client component, so this module
   has always BEEN a client boundary — it just never declared one. Without the
   directive the bundler was free to pull it into the server graph as well, and any
   page that rendered a Button from a server component while the shared header
   rendered one from the client graph got two copies of the module and a render that
   threw "Element type is invalid … got: undefined". It cost a long bisect on the
   home page and again on /open-source, and neither tsc, eslint nor the type checker
   can see it — only a production build at request time.

   `buttonVariants` is exported from here and CALLED in two places; both are already
   client components (apps/docs/components/ai/page-actions.tsx, packages/ui/calendar.tsx),
   so promoting this file to a client module costs nothing. Keep it that way: a server
   component cannot call a value imported from a client module. */
"use client";

import { Button as ButtonPrimitive } from "@base-ui-components/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

import { cn } from "./utils"

const buttonVariants = cva(
  // `vx-clamp` (packages/brand/src/tokens.css) draws the four corner marks that
  // reach in and clamp on hover/focus. They are absolutely positioned OUTSIDE this
  // padding box, so the label never shifts and the control never reflows. Because
  // the device is geometry rather than glyphs, it needs no room inside the control
  // — which is why every icon and `xs` size can now wear it instead of opting out.
  "vx-clamp inline-flex shrink-0 items-center justify-center gap-2 rounded-none text-sm font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,translate] duration-[var(--dur-2)] ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-[0.5px] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-ring-invalid [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "border border-border bg-transparent text-foreground shadow-xs hover:border-foreground hover:bg-[var(--signal-critical-surface)] focus-visible:ring-ring/50",
        outline:
          "border border-input bg-input-fill shadow-xs hover:bg-input-fill-hover hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        // No box to bracket, and no press displacement on a run of text.
        link: "vx-clamp-none active:translate-y-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        // Small controls take the tight reach so the marks stay proportionate.
        xs: "vx-clamp--tight h-6 gap-1 rounded-none px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-none px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-none px-6 has-[>svg]:px-4",
        // Icon buttons clamp too: the marks sit outside the square, so nothing collides.
        icon: "size-9",
        "icon-xs":
          "vx-clamp--tight size-6 rounded-none [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "vx-clamp--tight size-8",
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
