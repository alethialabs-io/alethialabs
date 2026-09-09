"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui-components/react/menu";
import { CheckIcon } from "lucide-react";

import { cn } from "./utils";

/**
 * A context menu that opens at a POINTER POSITION the caller hands it, built on base-ui `Menu`
 * with a virtual anchor — deliberately NOT base-ui's `ContextMenu` primitive.
 *
 * Why not the primitive: React Flow 12 (`@xyflow/react`) swallows the DOM `contextmenu` event on
 * its pane when `panOnDrag` includes mouse button 2 and instead fires `onPaneContextMenu` from the
 * mouseup of a right-press that did NOT pan. A trigger that opens on `contextmenu` would therefore
 * open on every right-drag. The canvas owns the event and hands this component a point; nothing
 * here listens to the DOM for it.
 *
 * The API is controlled only: `open` + `onOpenChange` + `anchor` on the root. The root renders no
 * DOM of its own; `ContextMenuContent` portals a `Menu.Positioner` anchored to
 * `virtualAnchor(anchor)` and a styled `Menu.Popup`. Styling, `data-slot` attributes and the
 * `onSelect → onClick` mapping are mirrored from `dropdown-menu.tsx` so the two menus read as one
 * product; keep them in step when either changes.
 *
 * Keyboard comes from base-ui: arrow keys move the highlight, Enter/Space activate, Escape closes
 * (it reaches the caller as `onOpenChange(false)`). `modal={false}` because the canvas underneath
 * stays interactive — a right-click elsewhere on the pane moves the menu rather than being eaten
 * by a backdrop.
 */

/** A viewport-relative point, in CSS pixels — what `MouseEvent.clientX/Y` gives you. */
export interface ContextMenuPoint {
  x: number;
  y: number;
}

/**
 * The rect a virtual anchor reports. Structurally the `ClientRectObject` Floating UI expects from
 * `VirtualElement.getBoundingClientRect()` (`Rect & SideObject`), declared here so this package
 * does not have to depend on `@floating-ui/*` directly to name it.
 */
export interface ContextMenuAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/**
 * A zero-size element Floating UI can position against — the shape base-ui's
 * `Menu.Positioner` accepts for `anchor` (its `VirtualElement` member).
 */
export interface ContextMenuVirtualAnchor {
  getBoundingClientRect: () => ContextMenuAnchorRect;
}

/**
 * Builds the zero-size virtual anchor for a point. Pure: the rect is `width = height = 0` at
 * `(x, y)`, so with `side="bottom" align="start"` the popup's top-left lands on the pointer and
 * base-ui's collision avoidance flips it when the viewport edge is near.
 */
export function virtualAnchor(
  point: ContextMenuPoint,
): ContextMenuVirtualAnchor {
  const { x, y } = point;
  const rect: ContextMenuAnchorRect = {
    x,
    y,
    width: 0,
    height: 0,
    top: y,
    left: x,
    right: x,
    bottom: y,
  };
  return { getBoundingClientRect: () => rect };
}

/** Root → Content channel for the anchor, so the caller sets it once on `ContextMenu`. */
const ContextMenuAnchorContext =
  React.createContext<ContextMenuVirtualAnchor | null>(null);

export interface ContextMenuProps {
  /** Whether the menu is showing. */
  open: boolean;
  /** Called with `false` on Escape, outside press or item activation; with `true` never — this
   * menu has no trigger, so opening is always the caller's decision. */
  onOpenChange: (open: boolean) => void;
  /** Where to open. `null` while closed; with `open` and no anchor the menu stays closed. */
  anchor: ContextMenuPoint | null;
  children?: React.ReactNode;
}

/**
 * The controlled root. Wraps base-ui `Menu.Root` (non-modal) and publishes the virtual anchor
 * for `ContextMenuContent`. Renders no DOM element itself.
 */
function ContextMenu({ open, onOpenChange, anchor, children }: ContextMenuProps) {
  // Memoise on the coordinates, not the object: callers routinely build `{ x, y }` inline, and a
  // fresh anchor identity every render would make base-ui re-run positioning for nothing.
  const x = anchor?.x;
  const y = anchor?.y;
  const virtual = React.useMemo(
    () => (x === undefined || y === undefined ? null : virtualAnchor({ x, y })),
    [x, y],
  );
  return (
    <ContextMenuAnchorContext.Provider value={virtual}>
      <MenuPrimitive.Root
        open={open && virtual !== null}
        // base-ui calls with `(open, eventDetails)`; the contract here is the boolean alone, so
        // the caller's handler never sees (and cannot come to depend on) base-ui's details object.
        onOpenChange={(next) => onOpenChange(next)}
        modal={false}
      >
        {children}
      </MenuPrimitive.Root>
    </ContextMenuAnchorContext.Provider>
  );
}

/**
 * The portalled, positioned popup. Anchors to the root's point with `side="bottom" align="start"`
 * (top-left on the pointer, collision-flipped by base-ui). Class list mirrors
 * `DropdownMenuContent`.
 */
function ContextMenuContent({
  className,
  ...props
}: Omit<React.ComponentProps<typeof MenuPrimitive.Popup>, "children"> & {
  children?: React.ReactNode;
}) {
  const anchor = React.useContext(ContextMenuAnchorContext);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={0}
      >
        <MenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "bg-popover text-popover-foreground data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-[var(--z-overlay)] max-h-(--available-height) min-w-[8rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/**
 * A selectable item. base-ui fires selection (mouse and keyboard) through `onClick` and closes
 * the menu afterwards, which reaches the root as `onOpenChange(false)`; `onSelect` is mapped onto
 * `onClick` exactly as `DropdownMenuItem` does so the two call-site APIs match.
 */
function ContextMenuItem({
  className,
  inset,
  variant = "default",
  onSelect,
  onClick,
  ...props
}: Omit<React.ComponentProps<typeof MenuPrimitive.Item>, "onSelect"> & {
  inset?: boolean;
  variant?: "default" | "destructive";
  /** Selection callback. base-ui's own `onSelect` is the DOM text-selection event, so this maps
   * onto `onClick`. */
  onSelect?: React.MouseEventHandler<HTMLElement>;
}) {
  const handleClick =
    onSelect || onClick
      ? (event: React.MouseEvent<HTMLElement>) => {
          onSelect?.(event);
          onClick?.(event);
        }
      : undefined;
  return (
    <MenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:data-[highlighted]:bg-destructive/10 dark:data-[variant=destructive]:data-[highlighted]:bg-destructive/20 data-[variant=destructive]:data-[highlighted]:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
      onClick={handleClick}
    />
  );
}

/**
 * A toggling item. Controlled through `checked` + `onCheckedChange`; base-ui keeps the menu open
 * after a toggle (`closeOnClick` defaults to false on checkbox items) so several can be flipped
 * in one visit.
 */
function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon className="size-4" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

/**
 * A free-standing heading inside the menu. A plain styled `<div>`, as `DropdownMenuLabel` is,
 * because base-ui's `Menu.GroupLabel` must live inside a `Menu.Group`.
 */
function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
}) {
  return (
    <div
      data-slot="context-menu-label"
      data-inset={inset || undefined}
      className={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  );
}

/** A horizontal rule between groups of items. */
function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
};
