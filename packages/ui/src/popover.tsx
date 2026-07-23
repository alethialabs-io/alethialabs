"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui-components/react/popover";

import { cn } from "./utils";

/** Groups all parts of the popover (base-ui `Popover.Root`). */
function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

/** The button that opens the popover. base-ui renders a real `<button>`; to use a custom element
 * pass `render={<El />}` (the base-ui replacement for Radix `asChild`). */
function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/**
 * The floating popover panel.
 *
 * Migrated Radix → base-ui: Radix `Portal > Content` → base-ui `Portal > Positioner > Popup`. The
 * placement props (`side`/`sideOffset`/`align`/`alignOffset`) drive the **Positioner**; the styled
 * className + `data-slot` live on the **Popup** (same visual element as the old Content). base-ui
 * sets `--transform-origin` / `--available-height` / `--anchor-width` on the Positioner (the Popup
 * inherits them as CSS custom properties), replacing Radix's
 * `--radix-popover-content-transform-origin` / `-available-height` / `-trigger-width`. State
 * attributes rekey `data-[state=open|closed]` → `data-[open]`/`data-[closed]`, so tw-animate-css
 * still drives enter/exit while base-ui keeps the popup mounted through the closing animation.
 */
function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  side,
  alignOffset,
  anchor,
  container,
  children,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Popup>, "children"> & {
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["side"];
  sideOffset?: React.ComponentProps<
    typeof PopoverPrimitive.Positioner
  >["sideOffset"];
  align?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["align"];
  alignOffset?: React.ComponentProps<
    typeof PopoverPrimitive.Positioner
  >["alignOffset"];
  /** Anchor the popup to a custom element/ref instead of the trigger (base-ui has no `Anchor` part
   * — this maps to the Positioner's `anchor` prop). */
  anchor?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["anchor"];
  /**
   * DOM node to portal the popup into (maps to base-ui `Popover.Portal`'s `root`). Base-ui's default
   * nests the portal inside the parent floating tree — so a popover opened from **inside a modal
   * Dialog** lands in the dialog's subtree, DOM-ordered *before* later positioned siblings (e.g. a
   * `position: relative` grid), which then paint over it and swallow clicks. Pass `container={document.body}`
   * to portal to `<body>` (Radix's old default): the popup becomes a later body child, painting above
   * the dialog content, while its React floating-tree membership (and inert-exemption) is preserved.
   */
  container?: React.ComponentProps<typeof PopoverPrimitive.Portal>["container"];
  children?: React.ReactNode;
}) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          // `relative` is load-bearing: base-ui positions the popup via the (absolute) Positioner and
          // leaves the Popup itself `position: static`, on which `z-index` is a no-op. Without a
          // position, the z-50 (and any caller override) is silently ignored, so a popover opened from
          // inside a z-50 layer (e.g. the fullscreen Elench dialog) renders *behind* that layer. Making
          // the Popup positioned lets its z-index actually apply.
          className={cn(
            "relative z-50 w-72 origin-(--transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

/**
 * Anchors the popover to a custom element instead of the trigger. base-ui's Popover has **no
 * `Anchor` part** — anchoring is done by passing an element/ref to the Positioner's `anchor` prop —
 * so this is a transparent passthrough that just renders its child. Callers that relied on
 * `PopoverAnchor` for positioning must instead give `PopoverContent` an `anchor` (a ref to the
 * element to position against); see `multi-combobox.tsx`.
 */
function PopoverAnchor({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

/** Optional header block inside a popover. */
function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  );
}

/** Popover heading. */
function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  );
}

/** Muted supporting copy inside a popover. */
function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
};
