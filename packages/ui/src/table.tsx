// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react"

import { cn } from "./utils"

/**
 * The row's `[ · ]` clamp, drawn by the row's FIRST CELL rather than by the row (#6237).
 *
 * `.vx-clamp` draws its corner marks with an absolutely positioned `::before` on the element that
 * carries it. On a `<tr>` that pseudo-element is a child of a table row, and Chrome lays it out as
 * a leading anonymous table cell: in a table with a `<colgroup>` that phantom cell takes the first
 * `<col>`'s width and every real column shifts one slot right; without one it is a narrow blank
 * leading column. A row may only have cells as children, so the row must not generate one.
 *
 * So `TableRow` keeps `.vx-clamp vx-clamp--tight` — for the device's `--cl-*` knobs and its
 * `position: relative` — and adds `.vx-clamp-none`, which tokens.css declares after the base rule
 * as `content: none`, so the row generates no `::before` box at all. The marks are drawn instead by
 * the first cell's `::before`. A cell is static, so that absolutely positioned pseudo-element
 * resolves against the RELATIVE row and spans the whole row, at the same `--cl-gap` outside it as
 * before. It is a child of a cell, not of the row, so it plays no part in table layout.
 *
 * The rules mirror `.vx-clamp::before` in `packages/brand/src/tokens.css` (masked border, resting
 * reach, opacity on hover / focus-visible / `[data-clamped]`). They live on `<Table>` and select
 * `[data-slot=table-row]`, so a page of rows carries them once, not once per row. A row that is
 * not a `TableRow`, or a `TableRow` outside a `<Table>`, gets no marks — never a misplaced one.
 */
const ROW_CLAMP_MARK = [
  "[&_[data-slot=table-row]>:first-child]:before:pointer-events-none",
  "[&_[data-slot=table-row]>:first-child]:before:absolute",
  "[&_[data-slot=table-row]>:first-child]:before:inset-[calc(-1*var(--cl-gap))]",
  "[&_[data-slot=table-row]>:first-child]:before:border",
  "[&_[data-slot=table-row]>:first-child]:before:border-[color:var(--cl-ink)]",
  "[&_[data-slot=table-row]>:first-child]:before:opacity-0",
  "[&_[data-slot=table-row]>:first-child]:before:[mask:linear-gradient(#000_0_0)_top_left/var(--cl-len)_var(--cl-len)_no-repeat,linear-gradient(#000_0_0)_top_right/var(--cl-len)_var(--cl-len)_no-repeat,linear-gradient(#000_0_0)_bottom_left/var(--cl-len)_var(--cl-len)_no-repeat,linear-gradient(#000_0_0)_bottom_right/var(--cl-len)_var(--cl-len)_no-repeat]",
  "[&_[data-slot=table-row]>:first-child]:before:[transition:opacity_var(--dur-1)_var(--ease),scale_var(--dur-2)_var(--ease-out)]",
  // The resting reach is motion, so it is only taken when motion is welcome: under
  // `prefers-reduced-motion` the marks arrive already clamped, as `.vx-clamp` does.
  "motion-safe:[&_[data-slot=table-row]>:first-child]:before:[scale:var(--cl-reach)]",
  "[&_[data-slot=table-row]:hover>:first-child]:before:opacity-[var(--cl-op)]",
  "[&_[data-slot=table-row]:hover>:first-child]:before:[scale:1]",
  "[&_[data-slot=table-row]:focus-visible>:first-child]:before:opacity-[var(--cl-op)]",
  "[&_[data-slot=table-row]:focus-visible>:first-child]:before:[scale:1]",
  "[&_[data-slot=table-row][data-clamped]>:first-child]:before:opacity-[var(--cl-op)]",
  "[&_[data-slot=table-row][data-clamped]>:first-child]:before:[scale:1]",
].join(" ")

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
        className={cn("w-full caption-bottom text-sm", ROW_CLAMP_MARK, className)}
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

/**
 * A table row. Its hover clamp is drawn by its first cell, never by a `::before` on the `<tr>` —
 * see `ROW_CLAMP_MARK` for why a row-level pseudo-element shifts every column right.
 */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "vx-clamp vx-clamp--tight vx-clamp-none border-b border-border/40 transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
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
