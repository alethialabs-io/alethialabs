"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui-components/react/tooltip";

import { cn } from "./utils";

/**
 * Shared tooltip delay provider. Keeps our zero-delay default and the historic
 * `delayDuration` prop name (call sites still pass `delayDuration={…}`); base-ui's
 * provider open-delay prop is `delay`, so we map the two.
 *
 * Migrated Radix → base-ui: `TooltipPrimitive.Provider` (Radix `delayDuration`) →
 * base-ui `Provider` (`delay`).
 */
function TooltipProvider({
  delayDuration = 0,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Provider>, "delay"> & {
  delayDuration?: number;
}) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delayDuration}
      {...props}
    />
  );
}

/** Groups the tooltip parts; wraps every tooltip in its own zero-delay Provider. */
function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

/** The trigger element. base-ui uses `render={<El/>}` (not Radix `asChild`) to merge onto a child. */
function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/**
 * The floating tooltip surface. Structural map Radix `Portal > Content` → base-ui
 * `Portal > Positioner > Popup`: placement (`sideOffset`) lives on the Positioner, while our
 * styled className + `data-slot` move to the Popup. base-ui `Portal` takes no className/data-slot.
 *
 * data-attr rekeys: `data-[state=open|closed]` → `data-[open]`/`data-[closed]`; transform-origin
 * CSS var `--radix-tooltip-content-transform-origin` → base-ui `--transform-origin`. tw-animate-css
 * enter/exit is retained, rekeyed to the new closed-state attribute.
 */
function TooltipContent({
  className,
  side,
  align,
  sideOffset = 4,
  alignOffset,
  children,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Popup>, "children"> &
  Pick<
    React.ComponentProps<typeof TooltipPrimitive.Positioner>,
    "side" | "align" | "sideOffset" | "alignOffset"
  > & {
    children?: React.ReactNode;
  }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--transform-origin) overflow-hidden rounded-md px-3 py-1.5 text-xs",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
