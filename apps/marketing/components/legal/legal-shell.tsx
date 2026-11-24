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

/** The `/legal` index's groups, in the order it shows them. */
export const LEGAL_GROUPS = ["Policies", "Data protection", "Product", "Company"] as const;

export type LegalGroup = (typeof LEGAL_GROUPS)[number];

export interface LegalDocumentLink {
	/** Short name, as the cross-link row shows it. */
	label: string;
	href: `/${string}`;
	/** One line for the `/legal` index: what the document is for. */
	description: string;
	group: LegalGroup;
}

/**
 * Every legal document on the site — the one list both the cross-links below
 * and the `/legal` index read, so a document added here appears in both.
 *
 * In cross-link order, which predates the groups and is kept as it was.
 *
 * Its name, its file and its declaration keyword are load-bearing:
 * `scripts/check-legal-set.mjs` (`parseShellIndex`) finds this list by its
 * declaration text in THIS file and reads every href inside it, to prove each
 * linked page is in `docs/legal/legal-set.json`. Move it to another file or
 * rename it and that guard goes red ("parser-blind"). For the same reason, do
 * not write the declaration's exact text in a comment above it: the parser
 * would start reading there.
 *
 * This is NOT `LEGAL_DOCUMENTS` in `@repo/legal/documents`: that is the
 * versioned, content-hashed record of what a person accepted at sign-up, and
 * covers only the clickwrap documents. This is navigation.
 */
export const DOCUMENTS: readonly LegalDocumentLink[] = [
	{ label: "Privacy", href: "/privacy", description: "What we collect, why, and for how long.", group: "Policies" },
	{ label: "Privacy requests", href: "/privacy/requests", description: "Exercise a data-protection right.", group: "Data protection" },
	{ label: "Terms", href: "/terms", description: "The agreement for using the hosted service.", group: "Policies" },
	{ label: "Refunds", href: "/refunds", description: "When we refund a payment, and how to ask for one.", group: "Policies" },
	{ label: "Acceptable use", href: "/acceptable-use", description: "What the service may not be used for.", group: "Policies" },
	{ label: "Cookies", href: "/cookies", description: "The cookies and similar technologies we use.", group: "Policies" },
	{ label: "DPA", href: "/legal/dpa", description: "GDPR processing terms for business customers.", group: "Data protection" },
	{ label: "Subprocessors", href: "/legal/subprocessors", description: "Providers that may process personal data for us.", group: "Data protection" },
	{ label: "Source & licenses", href: "/legal/source", description: "Licence boundaries, and where to get the AGPL source.", group: "Product" },
	{ label: "Data Act", href: "/legal/data-act", description: "Switching providers and taking your data with you.", group: "Data protection" },
	{ label: "AI transparency", href: "/ai-transparency", description: "What the AI assistant is, what it can get wrong, and who provides it.", group: "Product" },
	{ label: "Consumer rights", href: "/consumer-rights", description: "Your statutory rights if you buy as a consumer.", group: "Product" },
	{ label: "Imprint", href: "/imprint", description: "Registered company and contact information.", group: "Company" },
	{ label: "Security", href: "/security", description: "How the service is protected, and how to report a vulnerability.", group: "Company" },
];

/** The documents in one `/legal` group, in list order. */
export function legalDocumentsIn(group: LegalGroup): LegalDocumentLink[] {
	return DOCUMENTS.filter((doc) => doc.group === group);
}

/**
 * The frame every legal document renders in, and the cross-links between them.
 *
 * This used to draw its own chrome: a bare logo pinned at `top-6 left-6` and a
 * footer holding one link. Twelve pages could therefore be reached but not left
 * — no nav, no way to `/pricing`, and no way from Privacy to the DPA it cites.
 * It now wears the same header and footer as the rest of the site, and carries
 * the index below.
 *
 * That index is load-bearing, not decoration. The site footer was cut from 32
 * links to 10, so these documents are no longer named there; this is what keeps
 * them one click apart instead of orphaned. `DOCUMENTS` above is exported so
 * the `/legal` index reads the same list rather than a copy.
 */
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
