"use client"
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui-components/react/scroll-area"
import type * as React from "react"

import { cn } from "./utils"

type ScrollAreaOrientation = "vertical" | "horizontal" | "both"

/** Minimal, auto-hiding scroll container over the base-ui ScrollArea primitive. base-ui hides the
 * native scrollbar on the viewport (inline `overflow: scroll` + a `.base-ui-disable-scrollbar`
 * style) and renders our own: a thin grayscale bar that is invisible when idle and fades in on
 * hover or while scrolling. `className` sizes / height-constrains the Root (the viewport fills it,
 * so the Root must have a bounded height for anything to scroll); `children` render inside the
 * scrollable viewport. Pass `orientation` to also / only show the horizontal bar. */
function ScrollArea({
  className,
  children,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  orientation?: ScrollAreaOrientation
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full overscroll-contain rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" && <ScrollBar orientation="vertical" />}
      {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

/** The auto-hiding grayscale scrollbar + thumb. base-ui toggles `data-hovering` / `data-scrolling`
 * on the bar (we fade opacity off those) and sets the thumb's length inline via a CSS var — our
 * classes only set the cross-axis thickness (`w-full` vertical / `h-full` horizontal). Thin (~6px)
 * and pill-shaped. */
function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "z-10 flex touch-none select-none p-px opacity-0 transition-opacity duration-150 data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[scrolling]:duration-0",
        orientation === "vertical" && "h-full w-2 justify-center",
        orientation === "horizontal" && "h-2 w-full flex-col justify-center",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          "rounded-full bg-foreground/25 transition-colors hover:bg-foreground/40",
          orientation === "vertical" && "w-full",
          orientation === "horizontal" && "h-full",
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
