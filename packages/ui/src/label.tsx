"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from "react";

import { cn } from "./utils";

/** Grayscale form label. base-ui has no standalone Label primitive (it only ships `Field.Label`), so
 * this renders a native `<label>` — the same styled element with `htmlFor`, and `select-none` keeps
 * the double-click-select suppression Radix's Label provided. */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
