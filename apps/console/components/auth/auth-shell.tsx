// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AlethiaLogo } from "@repo/brand/alethia-logo";
import { LEGAL_ENTITY } from "@repo/brand/legal";
import { cn } from "@repo/ui/utils";
import { legalUrl } from "@/lib/legal";

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
 * Shared chrome for the auth + onboarding screens (login / signup / onboarding):
 * a topbar with the Alethia Labs lockup and an optional sign-in/sign-up switch,
 * the centered card area, and the legal + status footer, over a plain background.
 */
export function AuthShell({
	switchPrompt,
	switchHref,
	switchLabel,
	cardWidth = "default",
	children,
}: AuthShellProps) {
	return (
		<div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
			{/* top bar */}
			<header className="relative z-30 flex items-center justify-between px-8 py-6">
				<Link
					href="/"
					aria-label="Alethia Labs — home"
					className="inline-flex items-center transition-opacity hover:opacity-80"
				>
					<AlethiaLogo withText className="h-6 w-auto text-foreground" />
				</Link>

				{switchPrompt && switchHref && switchLabel ? (
					<div className="flex items-center gap-3 whitespace-nowrap">
						<span className="hidden text-[13px] text-text-tertiary sm:inline">
							{switchPrompt}
						</span>
						<Link
							href={switchHref}
							className="inline-flex h-[34px] items-center gap-[7px] rounded-sm border border-border-strong px-3.5 text-[13px] font-medium text-text-primary transition-colors hover:border-ring hover:bg-surface-muted"
						>
							{switchLabel}
							<ArrowRight className="size-3.5 opacity-70" />
						</Link>
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
				<div className="flex items-center gap-4 font-mono text-[10.5px] tracking-[0.06em] text-text-tertiary">
					<span>© 2026 {LEGAL_ENTITY.tradingName}</span>
					<a
						href={legalUrl("/terms")}
						className="transition-colors hover:text-text-primary"
					>
						Terms
					</a>
					<a
						href={legalUrl("/privacy")}
						className="transition-colors hover:text-text-primary"
					>
						Privacy
					</a>
				</div>
				<a
					href="https://status.alethialabs.io"
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-2"
				>
					<span className="ah-pulse" />
					<span className="font-mono text-[10.5px] tracking-[0.06em] text-text-tertiary transition-colors hover:text-text-primary">
						All systems operational
					</span>
				</a>
			</footer>
		</div>
	);
}

/**
 * The card surface that wraps a single auth/onboarding step. Mirrors the
 * design's `.panel` (whisper-cornered surface, hairline + soft shadow) and
 * plays the entrance animation on mount/step-change.
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
				"auth-pane-in rounded-xl border border-border bg-[color-mix(in_oklab,var(--surface)_92%,transparent)] px-9 pb-8 pt-9 shadow-[0_1px_0_0_var(--border-faint),var(--shadow-lg)]",
				className,
			)}
		>
			{children}
		</div>
	);
}
