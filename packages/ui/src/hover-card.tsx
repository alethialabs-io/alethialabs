"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { PreviewCard as PreviewCardPrimitive } from "@base-ui-components/react/preview-card";

import { cn } from "./utils";

/**
 * Hover-triggered card. Migrated Radix `HoverCard` → base-ui `PreviewCard` (the export names are
 * kept). Note the open/close delays moved: Radix took `openDelay`/`closeDelay` on the Root, but
 * base-ui takes `delay`/`closeDelay` on the **Trigger** — so pass them to `HoverCardTrigger`, not
 * `HoverCard`.
 */
function HoverCard({
  ...props
}: React.ComponentProps<typeof PreviewCardPrimitive.Root>) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

/** The element that opens the card on hover/focus. Accepts base-ui `delay`/`closeDelay` (ms).
 * base-ui renders an `<a>`; use `render={<El />}` in place of Radix `asChild`. */
function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof PreviewCardPrimitive.Trigger>) {
  return (
    <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

/**
 * The floating card panel.
 *
 * Migrated Radix `Portal > Content` → base-ui `Portal > Positioner > Popup`. Placement props
 * (`side`/`sideOffset`/`align`/`alignOffset`) drive the **Positioner**; the styled className +
 * `data-slot` live on the **Popup**. base-ui sets `--transform-origin` on the Positioner (the Popup
 * inherits it), replacing Radix's `--radix-hover-card-content-transform-origin`; state attributes
 * rekey `data-[state=open|closed]` → `data-[open]`/`data-[closed]`.
 */
function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  side,
  alignOffset,
  children,
  ...props
}: Omit<React.ComponentProps<typeof PreviewCardPrimitive.Popup>, "children"> & {
  side?: React.ComponentProps<typeof PreviewCardPrimitive.Positioner>["side"];
  sideOffset?: React.ComponentProps<
    typeof PreviewCardPrimitive.Positioner
  >["sideOffset"];
  align?: React.ComponentProps<typeof PreviewCardPrimitive.Positioner>["align"];
  alignOffset?: React.ComponentProps<
    typeof PreviewCardPrimitive.Positioner
  >["alignOffset"];
  children?: React.ReactNode;
}) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "z-50 w-64 origin-(--transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95",
            className,
          )}
          {...props}
        >
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
