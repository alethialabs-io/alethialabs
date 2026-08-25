// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SiteShell } from "@repo/brand/site-shell";
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
 * Every legal document in the site, and the only place their cross-links live.
 *
 * This used to draw its own chrome: a bare logo pinned at `top-6 left-6` and a
 * footer holding one link. Twelve pages could therefore be reached but not left
 * — no nav, no way to `/pricing`, and no way from Privacy to the DPA it cites.
 * It now wears the same header and footer as the rest of the site, and carries
 * the index below.
 *
 * That index is load-bearing, not decoration. The site footer was cut from 32
 * links to 10, so these documents are no longer named there; this is what keeps
 * them one click apart instead of orphaned.
 */

const DOCUMENTS: { label: string; href: string }[] = [
	{ label: "Privacy", href: "/privacy" },
	{ label: "Privacy requests", href: "/privacy/requests" },
	{ label: "Terms", href: "/terms" },
	{ label: "Acceptable use", href: "/acceptable-use" },
	{ label: "Cookies", href: "/cookies" },
	{ label: "DPA", href: "/legal/dpa" },
	{ label: "Subprocessors", href: "/legal/subprocessors" },
	{ label: "Source & licenses", href: "/legal/source" },
	{ label: "Data Act", href: "/legal/data-act" },
	{ label: "AI transparency", href: "/ai-transparency" },
	{ label: "Consumer rights", href: "/consumer-rights" },
	{ label: "Imprint", href: "/imprint" },
	{ label: "Security", href: "/security" },
];

export function LegalShell({ title, lastUpdated, children }: LegalShellProps) {
	return (
		<SiteShell>
			<div className="w-full max-w-2xl mx-auto px-6 pt-20 pb-24">
				<header className="mb-10">
					<h1 className="text-3xl font-semibold tracking-tight text-foreground">
						{title}
					</h1>
					<p className="vx-eyebrow mt-3">Last updated · {lastUpdated}</p>
				</header>

				<div className="vx-prose">
					{children}
				</div>

				<nav
					aria-label="Legal documents"
					className="mt-16 pt-6 border-t border-border/60"
				>
					<p className="vx-eyebrow mb-4">All legal documents</p>
					<ul className="flex flex-wrap gap-x-5 gap-y-2 list-none p-0 m-0">
						{DOCUMENTS.map((doc) => (
							<li key={doc.href}>
								<Link
									href={doc.href}
									className="vx-clamp vx-clamp--tight text-xs text-muted-foreground no-underline hover:text-foreground transition-colors duration-[var(--dur-1)]"
								>
									{doc.label}
								</Link>
							</li>
						))}
					</ul>
				</nav>
			</div>
		</SiteShell>
	);
}
