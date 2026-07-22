"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canonical "?" help affordance placed next to a form label: a small HelpCircle
// button that opens a popover with a short explanation. Shared design-system component
// (alerts/runners/connectors all use this instead of their own copies).

import { ArrowUpRight, HelpCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "./utils";

interface FieldHelpProps {
  title: string;
  children: ReactNode;
  className?: string;
  /** Optional docs link — renders a "Learn more →" footer below the explanation. */
  docsHref?: string;
  /** Label for the docs link (defaults to "Learn more"). */
  docsLabel?: string;
  /** Popover side (defaults to top), for header vs inline placements. */
  side?: "top" | "right" | "bottom" | "left";
  /** Popover alignment (defaults to start). */
  align?: "start" | "center" | "end";
}

/**
 * A "?" popover for inline guidance (title + free-form explanation), with an optional
 * "Learn more →" docs link. The canonical help affordance across the console.
 */
export function FieldHelp({
  title,
  children,
  className,
  docsHref,
  docsLabel = "Learn more",
  side = "top",
  align = "start",
}: FieldHelpProps) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Help: ${title}`}
            className={cn(
              "inline-flex items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground",
              className,
            )}
          >
            <HelpCircle className="size-3.5" />
          </button>
        }
      />
      <PopoverContent side={side} align={align} className="w-72 p-3">
        <p className="mb-1 font-medium text-foreground text-xs">{title}</p>
        <div className="text-muted-foreground text-xs leading-relaxed">
          {children}
        </div>
        {docsHref && (
          <a
            href={docsHref}
            className="mt-2.5 inline-flex items-center gap-1 border-border border-b pb-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
          >
            {docsLabel}
            <ArrowUpRight className="size-3" />
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}
