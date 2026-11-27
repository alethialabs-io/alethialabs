// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single branded surface for 404s and error boundaries — ROUTES only. No "use client" —
// usable from both server components (not-found.tsx) and client error boundaries
// (error.tsx / global-error.tsx). Actions are passed in by the caller so each
// boundary supplies its own links / reset() buttons.
//
// Promoted from apps/console/components/errors/ (#7734) so marketing, blog and docs can render the
// same surface. The brand mark is a `mark` slot rather than an import: `@repo/brand` depends on
// `@repo/ui`, so importing `AlethiaMark` here would make the two packages a cycle.
//
// A data REGION that failed to load is not a route error: use `RegionError`
// (./region-error.tsx), or the console `DataTable`'s `query` prop for a table. This one renders the
// route's heading, which is right when it replaces the page and a stray second `<h1>` inside it.
// In the console, apps/console/tests/components/errors/error-state-placement.test.tsx holds the
// line (#6117).
//
// THE BRACKETED CODE (#7875). `codeVariant="bracketed"` sets the code between the mark's two
// brackets — `[ 404 ]` — in the display face, which is the signed-off 404 form (polish-wave spec
// §4). The bracket paths are the `[·]` mark's, each cropped to its own box exactly as
// `AlethiaLockup` crops them in `packages/brand/src/lockup.tsx`; they are copied rather than
// imported for the same cycle reason as `mark`. Change the geometry there and change it here.
// The code itself stays a text node of its own, so `getByText("404", { exact: true })` still finds
// it and a screen reader hears "404", not the brackets.

import type { ReactNode, SVGProps } from "react";
import { cn } from "./utils";

/** How the status code is set: a small mono line, or the brand's bracketed display form. */
export type ErrorStateCodeVariant = "mono" | "bracketed";

interface ErrorStateProps {
	/** The status code above the title, e.g. "404" or "500". */
	code?: string;
	/**
	 * `"mono"` (default) is a small tracked mono line. `"bracketed"` sets the code inside the mark's
	 * brackets, `[ 404 ]`, in Space Grotesk 600 at a display rung — the 404 form.
	 */
	codeVariant?: ErrorStateCodeVariant;
	title: string;
	description?: string;
	/** A row of buttons/links — the caller owns navigation + reset(). */
	actions?: ReactNode;
	/** Centered full-screen layout, with `mark` above it (for top-level pages); otherwise a
	 * compact in-content panel (for errors rendered inside the dashboard shell). */
	fullPage?: boolean;
	/**
	 * The brand mark above the code, full-page layout only, e.g. `<AlethiaMark />` from
	 * `@repo/brand/lockup`. It is sized and coloured here, and hidden from assistive technology.
	 */
	mark?: ReactNode;
	className?: string;
}

/** The `[·]` mark's bracket stroke, shared by both halves of the bracketed code. */
const BRACKET_STROKE: SVGProps<SVGPathElement> = {
	stroke: "currentColor",
	strokeWidth: 2.4,
	strokeLinecap: "round",
	strokeLinejoin: "round",
};

/**
 * The code set between the mark's brackets, `[ 404 ]`. Each bracket is one of the mark's paths in
 * its own cropped viewBox (the lockup's crop), sized to the line so it scales with the rung.
 */
function BracketedCode({ code, fullPage }: { code: string; fullPage: boolean }) {
	return (
		<span
			data-slot="error-state-code"
			className={cn(
				"inline-flex items-center gap-[0.32em] font-grotesk font-semibold leading-none tracking-display text-text-primary",
				fullPage ? "text-display-sm" : "text-display-xs",
			)}
		>
			<svg viewBox="5 4.5 7.5 23" fill="none" aria-hidden="true" className="block h-[1.3em] w-auto shrink-0">
				<path d="M11 6 H6.5 V26 H11" {...BRACKET_STROKE} />
			</svg>
			<span>{code}</span>
			<svg viewBox="19.5 4.5 7.5 23" fill="none" aria-hidden="true" className="block h-[1.3em] w-auto shrink-0">
				<path d="M21 6 H25.5 V26 H21" {...BRACKET_STROKE} />
			</svg>
		</span>
	);
}

/** Branded empty/error state shared by every 404 and error boundary. */
export function ErrorState({
	code,
	codeVariant = "mono",
	title,
	description,
	actions,
	fullPage = false,
	mark,
	className,
}: ErrorStateProps) {
	const body = (
		<div
			className={cn(
				"flex flex-col items-center text-center",
				fullPage ? "max-w-[420px] gap-5" : "max-w-[360px] gap-3",
				className,
			)}
		>
			{fullPage && mark ? (
				<span
					data-slot="error-state-mark"
					aria-hidden
					className="mb-1 block size-7 text-text-primary [&>svg]:size-full"
				>
					{mark}
				</span>
			) : null}
			{code && codeVariant === "bracketed" ? <BracketedCode code={code} fullPage={fullPage} /> : null}
			{code && codeVariant === "mono" ? (
				<span className="font-mono text-ui-sm uppercase tracking-[0.22em] text-text-tertiary">
					{code}
				</span>
			) : null}
			<h1
				className={cn(
					"font-grotesk font-semibold tracking-[-0.02em] text-text-primary",
					fullPage ? "text-ui-xl" : "text-ui-xl",
				)}
			>
				{title}
			</h1>
			{description && (
				<p className="text-ui-md leading-relaxed text-text-tertiary">
					{description}
				</p>
			)}
			{actions && (
				<div className="mt-2 flex flex-wrap items-center justify-center gap-2">
					{actions}
				</div>
			)}
		</div>
	);

	if (!fullPage) {
		return (
			<div className="flex min-h-[320px] flex-1 items-center justify-center px-6 py-12">
				{body}
			</div>
		);
	}
	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-6">
			{body}
		</div>
	);
}
