// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@repo/brand/site-shell";
import { Eyebrow, PageOpen, Section } from "@repo/brand/site-sections";
import { LEGAL_GROUPS, legalDocumentsIn } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Legal",
	description:
		"Every policy, notice and agreement that governs Alethia — privacy, terms, data protection, AI transparency and company information.",
};

/**
 * The legal index: every document, grouped, with one line each.
 *
 * It reads the same list `LegalShell` cross-links from, so a document added
 * there appears here without a second edit. No `Reveal`: this is a page people
 * scan for one link, and nothing on it should arrive late.
 */
export default function LegalIndexPage() {
	return (
		<SiteShell>
			<PageOpen
				lines={["Legal"]}
				side={{
					kind: "lede",
					text: "Every policy, notice and agreement that governs Alethia, in one place.",
				}}
			/>
			<Section>
				<div className="grid grid-cols-1 gap-x-16 gap-y-14 sm:grid-cols-2">
					{LEGAL_GROUPS.map((group) => (
						<div key={group} className="min-w-0">
							<Eyebrow>{group}</Eyebrow>
							<ul className="m-0 list-none space-y-5 p-0">
								{legalDocumentsIn(group).map((doc) => (
									<li key={doc.href}>
										<Link
											href={doc.href}
											className="font-grotesk text-[15px] font-semibold text-text-primary no-underline transition-colors hover:text-text-secondary"
										>
											{doc.label}
										</Link>
										<p className="m-0 mt-1 max-w-[42ch] text-[13px] leading-[1.6] text-text-secondary">
											{doc.description}
										</p>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			</Section>
		</SiteShell>
	);
}
