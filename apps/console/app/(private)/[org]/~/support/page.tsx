// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClipboardCheck, Flag, Inbox, Sparkles, Users } from "lucide-react";
import { SupportBrowseTopics } from "@/components/support/support-topics";
import { SupportCard } from "@/components/support/support-card";
import { SupportWhatsNew } from "@/components/support/support-whats-new";
import { globalHref } from "@/lib/routing";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Support",
	description:
		"Get help with Alethia — track your cases, open a new case, ask AI, or report abuse.",
});

// TODO: point the community card at a real forum once it exists; falls back to a
// disabled "coming soon" card when NEXT_PUBLIC_COMMUNITY_URL is unset.
const COMMUNITY_URL = process.env.NEXT_PUBLIC_COMMUNITY_URL;

/** Faint grid-pattern backdrop behind the hero, faded out with a radial mask. Decorative. */
const HERO_GRID_STYLE = {
	backgroundImage:
		"linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
	backgroundSize: "44px 44px",
	maskImage:
		"radial-gradient(ellipse 70% 80% at 50% 30%, #000 0%, transparent 75%)",
	WebkitMaskImage:
		"radial-gradient(ellipse 70% 80% at 50% 30%, #000 0%, transparent 75%)",
} as const;

/**
 * The support landing hub — "What can we help you with?". A masked grid-pattern hero over two
 * primary entry points (My cases · Submit a case) and three secondary ones (Ask AI · Report
 * abuse · Ask community), then the "See what's new" band and the knowledge-base topic grid.
 */
export default async function SupportPage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const base = globalHref(org, "support");

	return (
		<div className="pb-4">
			{/* Hero + entry-point cards */}
			<section className="relative overflow-hidden">
				<div
					aria-hidden
					className="pointer-events-none absolute inset-0"
					style={HERO_GRID_STYLE}
				/>
				<div className="relative mx-auto max-w-4xl px-2 pt-14 pb-16">
					<p className="mb-4 text-center font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
						Alethia Support
					</p>
					<h1 className="mb-10 text-center text-4xl font-semibold tracking-tight">
						What can we help you with?
					</h1>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<SupportCard
							icon={Inbox}
							title="My cases"
							description="View and manage your open and resolved support cases."
							href={`${base}/my-cases`}
						/>
						<SupportCard
							icon={ClipboardCheck}
							title="Submit a case"
							description="Create a new support case for your issue."
							href={`${base}/submit`}
						/>
					</div>

					<div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
						<SupportCard
							icon={Sparkles}
							title="Ask AI"
							description="Get instant answers from the Alethia platform assistant."
							href={`${base}/ask`}
						/>
						<SupportCard
							icon={Flag}
							title="Report abuse"
							description="Create and submit an abuse or security report."
							href={`${base}/abuse`}
						/>
						<SupportCard
							icon={Users}
							title="Ask community"
							description={
								COMMUNITY_URL
									? "Questions and answers from fellow Alethia engineers."
									: "Community discussions — coming soon."
							}
							href={COMMUNITY_URL}
							external={Boolean(COMMUNITY_URL)}
							disabled={!COMMUNITY_URL}
						/>
					</div>
				</div>
			</section>

			<SupportWhatsNew />
			<SupportBrowseTopics />
		</div>
	);
}
