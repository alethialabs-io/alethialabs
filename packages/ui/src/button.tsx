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

   `buttonVariants` is exported from here and imported in exactly ONE place —
   packages/ui/src/calendar.tsx, which is itself a client component — so promoting this
   file to a client module costs nothing. Keep it that way: a server component cannot
   call a value imported from a client module.

   The earlier version of this note named a second caller,
   apps/docs/components/ai/page-actions.tsx. That file imports a DIFFERENT
   `buttonVariants`, from fumadocs-ui/components/ui/button, and apps/docs does not
   declare @repo/ui as a dependency at all — under pnpm's isolated node_modules an
   undeclared import does not resolve, so it could not have been this export even by
   accident. The rule was right and its evidence was half wrong, which is worse than no
   evidence: the next person to widen this file's surface would have checked two callers,
   found one of them irrelevant, and had no way to tell whether the rule or the citation
   was the stale half. The claim is now checked rather than asserted — see
   `pnpm check:ui-client-boundary`. */
"use client";

import { Button as ButtonPrimitive } from "@base-ui-components/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { isValidElement } from "react"
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

/**
 * Whether `render` is an element that NAVIGATES — an `<a href>`, a Next `<Link href>`, or anything
 * else carrying an `href` prop (a string, or the UrlObject `Link` also accepts).
 *
 * Only the element form can be read. A render FUNCTION builds its element at render time inside
 * base-ui, so its href is invisible from here and such a caller must still pass `role="link"`
 * itself; every caller in the repo today uses the element form.
 */
function rendersLink(render: ButtonProps["render"]): boolean {
  return isValidElement<{ href?: unknown }>(render) && render.props.href != null
}

/** Grayscale/squared button. Migrated off Radix `Slot` to the base-ui `Button` primitive: pass a
 * `render` prop (base-ui's `asChild` replacement, e.g. `render={<Link href="…" />}`) to render as a
 * different element; the button's children merge into it. `nativeButton={false}` when rendering a
 * non-`<button>` element (e.g. an anchor). base-ui's Button is itself a client component, so this
 * wrapper stays server-compatible.
 *
 * A `render` element with an `href` is announced as a LINK. base-ui's `useButton` merges
 * `{role: "button"}` onto every non-native element it renders (`use-button/useButton.js`), so
 * `<Button nativeButton={false} render={<Link href="/" />}>` used to reach the accessibility tree as
 * `<a href role="button">`: a screen reader said "button" for a control that navigates, and
 * `getByRole("link")` could not find it (#5444). base-ui merges external props LAST, so the `role`
 * set here wins over its default — and a caller's own `role` still wins over this one. Separately,
 * an href defaults `nativeButton` to false: an anchor is never a native `<button>`, and
 * base-ui otherwise stamps `type="button"` on it and logs a mismatch in development.
 *
 * What the role does NOT change is base-ui's key handling. Its `onKeyUp` calls the caller's
 * `onClick` on Space for every non-native element, a `role="link"` anchor included (only the
 * Enter path is skipped for a real `<a href>`, which it leaves to the browser). A native link does
 * not activate on Space; a link-Button whose `onClick` does work will run it there, though Space
 * still does not navigate. This wrapper does not intercept `onKeyUp`. */
function Button({
  className,
  variant = "default",
  size = "default",
  render,
  nativeButton,
  role,
  ...props
}: ButtonProps) {
  const link = rendersLink(render)
  // Omitted, never `role={undefined}`: base-ui's mergeProps copies an own key whatever its value,
  // so an explicit undefined would ERASE the `role="button"` a non-native, non-link render needs.
  const resolvedRole = role ?? (link ? "link" : undefined)
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      render={render}
      nativeButton={nativeButton ?? !link}
      {...(resolvedRole === undefined ? {} : { role: resolvedRole })}
      {...props}
    />
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
