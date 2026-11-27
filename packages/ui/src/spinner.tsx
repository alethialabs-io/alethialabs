// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* The `[·]` mark as a loader glyph (polish-wave spec §2, #7740). It lives HERE, not in
   @repo/brand, because the dependency runs brand → ui (packages/brand/package.json depends on
   @repo/ui), so ui cannot import brand without a cycle. @repo/brand/loader's `MarkLoader` draws
   its region and page sizes with this same `MarkGlyph`, so there is one drawing of the loader.

   The animation is CSS only — `.ah-loader__*` and its keyframes in packages/brand/src/tokens.css,
   which every app that renders these imports — with a reduced-motion rule beside it. */

import type * as React from "react"

import { cn } from "./utils"

/** What `MarkGlyph` accepts: any `<svg>` attribute but children, plus the bracket stroke. */
type MarkGlyphProps = Omit<React.ComponentProps<"svg">, "children"> & {
  /**
   * Bracket stroke in viewBox units. The canonical mark is 2.4; the 16px inline loader draws 2.8
   * so its brackets hold their weight at that size.
   */
  bracketStroke?: number
}

/**
 * The animated `[·]` glyph: the canonical mark's geometry (viewBox 0 0 32 32, dot r 2.9) with the
 * loader's class names on each part. It draws in `currentColor` and declares no role or name —
 * the caller decides whether it is announced (`Spinner`, `MarkLoader`) or decorative (a pending
 * `Button`, which says `aria-busy` itself).
 */
function MarkGlyph({ bracketStroke = 2.4, className, ...props }: MarkGlyphProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      focusable="false"
      data-slot="mark-glyph"
      className={cn("ah-loader__glyph", className)}
      {...props}
    >
      <path
        className="ah-loader__br ah-loader__br--l"
        d="M11 6 H6.5 V26 H11"
        stroke="currentColor"
        strokeWidth={bracketStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="ah-loader__br ah-loader__br--r"
        d="M21 6 H25.5 V26 H21"
        stroke="currentColor"
        strokeWidth={bracketStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="ah-loader__dot" cx="16" cy="16" r="2.9" fill="currentColor" />
    </svg>
  )
}

/** The inline loader's edge, in px, and its stroke (spec §2: "inline 16px, stroke 2.8"). */
const INLINE_PX = 16
const INLINE_STROKE = 2.8

/** What `Spinner` accepts: `<svg>` attributes plus lucide's old `size` shorthand. */
type SpinnerProps = Omit<MarkGlyphProps, "bracketStroke"> & {
  /** Rendered edge in px (or any CSS length). A `size-*` class wins over it, as it did before. */
  size?: number | string
}

/**
 * The inline `[·]` loader, announced as a status. It replaced a spinning lucide `Loader2Icon`;
 * the props are the same (`className`, `size`, any svg attribute), so every call site kept working.
 * Inside a button, prefer `<Button pending>`, which draws this mark itself.
 */
function Spinner({ size = INLINE_PX, ...props }: SpinnerProps) {
  return (
    <MarkGlyph
      role="status"
      aria-label="Loading"
      width={size}
      height={size}
      bracketStroke={INLINE_STROKE}
      {...props}
    />
  )
}

export { MarkGlyph, Spinner, INLINE_PX, INLINE_STROKE }
export type { MarkGlyphProps, SpinnerProps }
