"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Small shared bits for the classification surface: an info hint (icon + tooltip that explains
// the *why*) and the inline `[·]` mark for pending buttons.

import { INLINE_STROKE, MarkGlyph } from "@repo/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { Info } from "lucide-react";
import type { ReactNode } from "react";

/** An unobtrusive info icon that reveals an explanation on hover/focus. */
export function InfoHint({
  children,
  size = 13,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label="More information"
            className={cn(
              "inline-grid place-items-center text-text-tertiary transition-colors hover:text-text-secondary",
              className,
            )}
          >
            <Info style={{ width: size, height: size }} />
          </button>
        }
      />
      <TooltipContent className="max-w-[240px] text-ui-sm leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The inline `[·]` mark for a button whose action is in flight — the same glyph `<Button pending>`
 * draws. Decorative: the button it sits in carries the state. A caller that can move to
 * `<Button pending>` with a progressive verb should, and drop this.
 */
export function Spinner({ size = 14 }: { size?: number }) {
  return <MarkGlyph width={size} height={size} bracketStroke={INLINE_STROKE} aria-hidden="true" />;
}
