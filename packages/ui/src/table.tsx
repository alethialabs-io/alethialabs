// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react"

import { cn } from "./utils"

/**
 * A table, in a wrapper that does NOT trap a sticky header.
 *
 * The wrapper used to be `overflow-x-auto`, and per spec `overflow-x: auto` computes `overflow-y`
 * to `auto` as well. That made it a vertical scroll container which never scrolls — so
 * `sticky top-0` on a `<thead>` stuck to a box with no overflow and did nothing. **Every sticky
 * table header in the console was inert, and always had been.**
 *
 * `overflow-x: clip` is the fix rather than removing the wrapper: unlike `auto` and `scroll`, clip
 * does NOT force the other axis, so `overflow-y` stays `visible`, the wrapper stops being a scroll
 * container, and a sticky header sticks against the PAGE — the header follows you down a long
 * list, which is what it was always claiming to do. It also drops the phantom horizontal scrollbar
 * these tables were carrying.
 *
 * @param scroll opt back into horizontal scrolling for a genuinely wide table. This re-creates the
 *   trap by definition, so a scrolling table must also give the wrapper a height (via `className`)
 *   if it wants a sticky header — otherwise do not put `sticky` on its `<thead>` at all. A table
 *   must not claim a behaviour it does not have.
 */
function Table({
  className,
  containerClassName,
  scroll = false,
  ...props
}: React.ComponentProps<"table"> & {
  scroll?: boolean
  containerClassName?: string
}) {
  return (
    <div
      data-slot="table-container"
      data-scroll={scroll || undefined}
      className={cn(
        "relative w-full",
        scroll ? "overflow-x-auto" : "overflow-x-clip",
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "vx-clamp vx-clamp--tight border-b border-border/40 transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-muted-foreground h-10 px-4 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-4 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
