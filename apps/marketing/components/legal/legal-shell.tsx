// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AlethiaLogo } from "@repo/brand/alethia-logo";
import { LEGAL_ENTITY } from "@repo/brand/legal";
import type { ReactNode } from "react";
import Link from "next/link";

interface LegalShellProps {
	/** Document title rendered as the page heading. */
	title: string;
	/** Human-readable "last updated" date shown under the title. */
	lastUpdated: string;
	/** Document body — plain semantic HTML (h2/h3/p/ul/a), styled by the shell. */
	children: ReactNode;
}

/**
 * Shared chrome and typography for the public legal pages (Terms, Privacy,
 * Cookies, Acceptable Use). Keeps every policy visually consistent with the
 * grayscale brand without pulling in a typography plugin — child semantic
 * elements are styled via arbitrary variants. Use <mark> for unresolved facts
 * so they read as obvious fill-in placeholders.
 */
export function LegalShell({ title, lastUpdated, children }: LegalShellProps) {
	return (
		<div className="min-h-screen bg-background flex flex-col">
			<div className="absolute top-6 left-6">
				<Link
					href="/"
					className="inline-flex items-center gap-2 hover:opacity-80 transition-opacity"
				>
					<AlethiaLogo withText className="h-6 w-auto text-foreground" />
				</Link>
			</div>

			<main className="flex-1 w-full max-w-2xl mx-auto px-6 pt-28 pb-20">
				<header className="mb-10">
					<h1 className="text-3xl font-semibold tracking-tight text-foreground">
						{title}
					</h1>
					<p className="vx-eyebrow mt-3">Last updated · {lastUpdated}</p>
				</header>

				<div
					className="space-y-4 text-sm leading-relaxed text-muted-foreground
						[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground
						[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-foreground
						[&_p]:leading-relaxed
						[&_ul]:my-3 [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:list-disc
						[&_li]:leading-relaxed
						[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:opacity-80
						[&_strong]:text-foreground [&_strong]:font-medium
						[&_code]:font-mono [&_code]:text-xs [&_code]:text-foreground
						[&_mark]:bg-muted [&_mark]:text-foreground [&_mark]:px-1.5 [&_mark]:py-0.5 [&_mark]:rounded [&_mark]:font-mono [&_mark]:text-xs"
				>
					{children}
				</div>

				<footer className="mt-16 pt-6 border-t border-border/60 flex items-center justify-between text-xs text-muted-foreground">
					<Link
						href="/"
						className="hover:text-foreground transition-colors"
					>
						← Back to home
					</Link>
					<span>Alethia · {LEGAL_ENTITY.tradingName}</span>
				</footer>
			</main>
		</div>
	);
}
