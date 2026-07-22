"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from "react";
import { Separator as SeparatorPrimitive } from "@base-ui-components/react/separator";

import { cn } from "./utils";

/** Grayscale hairline separator. Migrated off `@radix-ui/react-separator` to the base-ui `Separator`
 * primitive. base-ui exposes `aria-orientation` but no `data-orientation`, so the axis sizing is
 * branched on the `orientation` value directly (visually identical). base-ui has no `decorative`
 * prop — it always renders a presentational separator, which matches every call site. */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive>) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "bg-border shrink-0",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
