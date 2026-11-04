"use client"
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The searchable command list behind every palette, switcher and picker in the console (#6145).
//
// Built on Base UI's Autocomplete, rendered INLINE (always open, list under the input): the
// documented command-palette pattern. Base UI filters with a yes/no test and cannot rank, so this
// wrapper turns its filtering OFF (`filter={null}`) and shows exactly the rows the caller ranked
// with `rankItems` / `useCommandSearch` from `@repo/ui/command-search`. The caller passes those
// rows as `filteredItems` (that is what `CommandEmpty` counts) and renders the same rows as
// `CommandItem`s, in the same order.
//
// Keyboard: arrow keys move the highlight, Enter runs the highlighted row's `onSelect`. The
// highlight does NOT wrap from the last row to the first unless a caller asks (`loopFocus`), which
// is what cmdk did. cmdk's Ctrl+N/P/J/K bindings have no Base UI counterpart and are gone. The
// first rendered result is highlighted; while a search is typed, callers rank disabled rows last
// (`isDisabled` on the ranker) so that row is one Enter can run, as cmdk skipped disabled rows. On a
// miss there is no row, so nothing is highlighted and Enter does nothing.
//
// ACTION ROWS ("New environment", "Create project") do not belong in the list: they are not search
// results, so they must never be an arrow-key row, take the highlight, or hide the empty text.
// Render them as a footer button after `CommandList`, inside the same popover, as the org, project
// and environment switchers do. Rows that ARE part of the list's own navigation (the node
// palette's "Back to services") stay ordinary items.

import * as React from "react"
import { Autocomplete } from "@base-ui/react/autocomplete"
import { SearchIcon } from "lucide-react"

import { DisabledReasonItemBody, joinDescribedBy } from "./disabled-reason"
import { cn } from "./utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog"

/** The root's `label`, read by `CommandInput` to name the search box. */
const CommandLabelContext = React.createContext<string | undefined>(undefined)

/** A stable empty row list, so a missing or empty `filteredItems` does not re-render the list. */
const NO_ITEMS: readonly unknown[] = []

/** What every `Command` root takes, whether rendered bare or inside `CommandDialog`. */
interface CommandSearchProps {
  /**
   * The search box's accessible name. Required in practice: the #5824 guard
   * (apps/console/tests/components/cmdk-root-labels.test.ts) fails any root rendered without one.
   */
  label?: string
  /** The rows being shown, already ranked against `search`. `CommandEmpty` shows when it is empty. */
  filteredItems: readonly unknown[]
  /** What is typed in the search box. Omit for an uncontrolled search. */
  search?: string
  /** Called with the new query on every keystroke. */
  onSearchChange?: (search: string) => void
  /** Whether the highlight wraps from the last row to the first. Off, as it was under cmdk. */
  loopFocus?: boolean
}

/**
 * The root of a searchable list: holds the query and the highlight, and names its search box with
 * `label`. Render a `CommandInput`, then a `CommandList` of the `filteredItems` as `CommandItem`s.
 */
function Command({
  label,
  filteredItems = NO_ITEMS,
  search,
  onSearchChange,
  loopFocus = false,
  className,
  children,
  ...props
}: CommandSearchProps & React.ComponentProps<"div">) {
  return (
    <CommandLabelContext.Provider value={label}>
      <Autocomplete.Root
        open
        inline
        items={filteredItems}
        // Base UI's own filtering is off: `filteredItems` is already the ranked result.
        filter={null}
        autoHighlight="always"
        keepHighlight
        loopFocus={loopFocus}
        value={search}
        onValueChange={(next) => onSearchChange?.(next)}
      >
        <div
          data-slot="command"
          className={cn(
            "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </Autocomplete.Root>
    </CommandLabelContext.Provider>
  )
}

/** A command list in a dialog, named and described by `title` / `description`. */
function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  filteredItems,
  search,
  onSearchChange,
  loopFocus,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> &
  Omit<CommandSearchProps, "label"> & {
    title?: string
    description?: string
    className?: string
    showCloseButton?: boolean
    children?: React.ReactNode
  }) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn("overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
      >
        {/* The title and description name the OPEN dialog, so they live inside it. Outside the
            popup they were rendered on the page while the dialog was closed: a heading for a dialog
            nobody had opened, read out by a screen reader and counted as page content (#6348). */}
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* `label={title}` names the search box after the dialog, so it is never unnamed (#5824). */}
        <Command
          label={title}
          filteredItems={filteredItems}
          search={search}
          onSearchChange={onSearchChange}
          loopFocus={loopFocus}
          className="**:data-[slot=command-input-wrapper]:h-12 [&_[data-slot=command-group-heading]]:px-2 [&_[data-slot=command-group-heading]]:font-medium [&_[data-slot=command-group-heading]]:text-muted-foreground [&_[data-slot=command-group]]:px-2 [&_[data-slot=command-group]~[data-slot=command-group]]:pt-0 [&_[data-slot=command-input-wrapper]_svg]:h-5 [&_[data-slot=command-input-wrapper]_svg]:w-5 [&_[data-slot=command-input]]:h-12 [&_[data-slot=command-item]]:px-2 [&_[data-slot=command-item]]:py-3 [&_[data-slot=command-item]_svg]:h-5 [&_[data-slot=command-item]_svg]:w-5"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

/** The search box. Named by the root's `label` unless it is given its own `aria-label`. */
function CommandInput({
  className,
  "aria-label": ariaLabel,
  ...props
}: Omit<React.ComponentProps<typeof Autocomplete.Input>, "className"> & {
  className?: string
}) {
  const label = React.useContext(CommandLabelContext)
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <Autocomplete.Input
        data-slot="command-input"
        aria-label={ariaLabel ?? label}
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

/** The scrolling list of rows. */
function CommandList({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Autocomplete.List>, "className" | "children"> & {
  className?: string
  children?: React.ReactNode
}) {
  return (
    <Autocomplete.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className
      )}
      {...props}
    >
      {children}
    </Autocomplete.List>
  )
}

/**
 * Shown when `filteredItems` is empty. Its element stays mounted (it is the live region that
 * announces "no results"), so it collapses to nothing while there are rows.
 */
function CommandEmpty({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Autocomplete.Empty>, "className"> & {
  className?: string
}) {
  return (
    <Autocomplete.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm empty:py-0", className)}
      {...props}
    />
  )
}

/**
 * A labelled run of rows. Renders NOTHING when it has no rows: Base UI always renders a group's
 * `role="group"` and its label, so a search miss would otherwise leave an orphan heading.
 */
function CommandGroup({
  className,
  heading,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Autocomplete.Group>, "className" | "children"> & {
  className?: string
  /** The group's visible label. */
  heading?: React.ReactNode
  children?: React.ReactNode
}) {
  if (React.Children.toArray(children).length === 0) return null
  return (
    <Autocomplete.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[data-slot=command-group-heading]]:px-2 [&_[data-slot=command-group-heading]]:py-1.5 [&_[data-slot=command-group-heading]]:text-xs [&_[data-slot=command-group-heading]]:font-medium [&_[data-slot=command-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {heading !== undefined && (
        <Autocomplete.GroupLabel data-slot="command-group-heading">
          {heading}
        </Autocomplete.GroupLabel>
      )}
      {children}
    </Autocomplete.Group>
  )
}

/** A rule between groups of rows. */
function CommandSeparator({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Autocomplete.Separator>, "className"> & {
  className?: string
}) {
  return (
    <Autocomplete.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

/**
 * A row. `onSelect` runs on a click and on Enter while the row is highlighted. `disabledReason`
 * disables it and shows the reason IN the row — see disabled-reason.tsx.
 */
function CommandItem({
  className,
  disabled,
  disabledReason,
  onSelect,
  children,
  "aria-describedby": ariaDescribedBy,
  ...props
}: Omit<
  React.ComponentProps<typeof Autocomplete.Item>,
  "className" | "onClick" | "value" | "children"
> & {
  className?: string
  children?: React.ReactNode
  /** Runs when the row is chosen, by pointer or by Enter. Never runs while the row is disabled. */
  onSelect?: () => void
  /** Why the row cannot be run. Set, it disables the row and renders the reason as secondary text. */
  disabledReason?: string | null
}) {
  const reasonId = React.useId()
  const isDisabled = Boolean(disabledReason) || Boolean(disabled)
  return (
    <Autocomplete.Item
      data-slot="command-item"
      disabled={isDisabled}
      onClick={() => {
        if (!isDisabled) onSelect?.()
      }}
      aria-describedby={
        disabledReason ? joinDescribedBy(ariaDescribedBy, reasonId) : ariaDescribedBy
      }
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        // The reason must not be dimmed with the row: the label dims instead.
        disabledReason && "data-disabled:opacity-100",
        className
      )}
      {...props}
    >
      {disabledReason ? (
        <DisabledReasonItemBody id={reasonId} reason={disabledReason}>
          {children}
        </DisabledReasonItemBody>
      ) : (
        children
      )}
    </Autocomplete.Item>
  )
}

/** A keyboard-shortcut hint at the end of a row. */
function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
