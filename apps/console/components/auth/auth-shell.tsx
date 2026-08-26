// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* Rendered from server pages (login, signup, onboarding, accept-terms) AND from a
   client one (`/cli/login`, which needs useSearchParams). A module reached from both
   graphs without a declared boundary is exactly what threw
   "Element type is invalid … got: undefined" twice during this rollout, so the
   boundary is declared here rather than inferred. It renders Button and
   PrivacySettingsButton, both client components, so it was one already. */
"use client";

import type React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AlethiaLockup } from "@repo/brand/lockup";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { PrivacySettingsButton } from "@repo/privacy/privacy-settings-button";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { legalUrl, statusUrl } from "@/lib/legal";

/** Width of the centered card; widens for the onboarding plan step. "fluid"
 *  hands width control to the child (the wizard animates it per step). */
type CardWidth = "default" | "wide" | "plans" | "fluid";

const CARD_MAX: Record<CardWidth, string> = {
  default: "max-w-[392px]",
  wide: "max-w-[496px]",
  plans: "max-w-[980px]",
  fluid: "max-w-none",
};

interface AuthShellProps {
  /** Right-hand topbar prompt, e.g. "New to Alethia?". Omit to hide the switch. */
  switchPrompt?: string;
  /** Where the switch link points, e.g. "/signup". */
  switchHref?: string;
  /** Switch link label, e.g. "Create an account". */
  switchLabel?: string;
  /** Card max-width; transitions between steps. Defaults to "default". */
  cardWidth?: CardWidth;
  children: React.ReactNode;
}

/**
 * The shell every public console screen wears.
 *
 * It used to cover four of the seven routes under `(public)`; `/auth/oauth/consent`,
 * `/invites/accept` and `/cli/login` each drew a near-miss copy of its logo and
 * centring, with different offsets and a different card. They all use this now, so
 * the front door of the product is one surface however you arrive at it.
 *
 * The blueprint grid backdrop is the same one the marketing hero uses — it became
 * shareable when `.ah-grid-bg` moved into `@repo/brand`. So did `.ah-pulse`, which
 * this footer had always referenced but which was only ever defined in the
 * marketing app's stylesheet: the status dot below rendered as a zero-size empty
 * span and had never once been visible.
 */
export function AuthShell({
  switchPrompt,
  switchHref,
  switchLabel,
  cardWidth = "default",
  children,
}: AuthShellProps) {
  const status = statusUrl();
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      <div className="ah-grid-bg" aria-hidden="true" />

      {/* top bar */}
      <header className="relative z-30 flex items-center justify-between px-8 py-6">
        <Link
          href="/"
          aria-label="Alethia Labs — home"
          className="vx-clamp vx-clamp--tight inline-flex items-center transition-opacity hover:opacity-80"
        >
          <AlethiaLockup size={24} className="text-text-primary" />
        </Link>

        {switchPrompt && switchHref && switchLabel ? (
          <div className="flex items-center gap-3 whitespace-nowrap">
            <span className="hidden text-[13px] text-text-tertiary sm:inline">
              {switchPrompt}
            </span>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href={switchHref} />}
            >
              {switchLabel}
              <ArrowRight className="size-3.5 opacity-70" />
            </Button>
          </div>
        ) : null}
      </header>

      {/* center stage */}
      <main className="relative z-20 flex flex-1 items-center justify-center px-6 pb-14 pt-2">
        <div
          className={cn(
            "w-full transition-[max-width] duration-[420ms] ease-[cubic-bezier(0.2,0,0,1)]",
            CARD_MAX[cardWidth],
          )}
        >
          {children}
        </div>
      </main>

      {/* footer */}
      <footer className="relative z-30 flex flex-wrap items-center justify-between gap-4 px-8 pb-7 pt-5">
        <div className="flex flex-wrap items-center gap-4 font-mono text-[10.5px] tracking-[0.06em] text-text-tertiary">
          {/* The year was hard-coded and would have quietly gone stale. */}
          <span>© {new Date().getFullYear()} {LEGAL_ENTITY.tradingName}</span>
          <a href={legalUrl("/terms")} className="vx-clamp vx-clamp--tight transition-colors hover:text-text-primary">
            Terms
          </a>
          <a href={legalUrl("/privacy")} className="vx-clamp vx-clamp--tight transition-colors hover:text-text-primary">
            Privacy
          </a>
          <a href={legalUrl("/legal/source")} className="vx-clamp vx-clamp--tight transition-colors hover:text-text-primary">
            Source
          </a>
          {/* Consent was withdrawable from the signed-in account menu and from
              nowhere on the public pages — where the choice is actually made. */}
          <PrivacySettingsButton className="vx-clamp vx-clamp--tight cursor-pointer transition-colors hover:text-text-primary" />
        </div>

        {status ? (
          <a
            href={status}
            target="_blank"
            rel="noreferrer"
            className="vx-clamp vx-clamp--tight inline-flex items-center gap-2"
          >
            <span className="ah-pulse" />
            <span className="font-mono text-[10.5px] tracking-[0.06em] text-text-tertiary transition-colors hover:text-text-primary">
              All systems operational
            </span>
          </a>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * The card surface that wraps a single auth/onboarding step.
 *
 * Was `rounded-xl` over a heavy `--shadow-lg`, which is a different surface from
 * every card on the rest of the site: elevation there reads from a hairline border,
 * not from drop-shadow. Squared and quiet now, and it keeps the entrance animation.
 */
export function AuthCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "auth-pane-in rounded-lg border border-border bg-surface px-9 pb-8 pt-9 shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}
