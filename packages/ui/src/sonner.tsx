"use client"
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { INLINE_STROKE, MarkGlyph } from "./spinner"

/** The app's toast host: sonner themed to the design system, with the [·] mark as its loading icon. */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        // The inline [·] mark. Decorative: the toast's own text says what is running and sonner's
        // live region announces it, so a second "Loading" status here would only repeat it.
        loading: (
          <MarkGlyph
            aria-hidden="true"
            className="size-4"
            bracketStroke={INLINE_STROKE}
          />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // sonner defaults to z-index 999999, which is not a layer so much as a refusal to
          // participate in one — and it made `--z-toast` a token with zero consumers, i.e. a
          // named layer that was pure fiction. Pinning it here is what makes the scale real.
          zIndex: "var(--z-toast)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
