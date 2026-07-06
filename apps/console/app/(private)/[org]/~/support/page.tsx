// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LifeBuoy, MessagesSquare, PlusCircle, ShieldAlert, Sparkles } from "lucide-react";
import { SupportCard } from "@/components/support/support-card";
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

/**
 * The support landing hub — "What can we help you with?" — a responsive grid of the
 * entry points: track existing cases, open a case, ask the AI assistant, report abuse,
 * and (when configured) ask the community.
 */
export default async function SupportPage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const base = globalHref(org, "support");

	return (
		<div className="space-y-8 py-2">
			<header className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					What can we help you with?
				</h1>
				<p className="text-sm text-muted-foreground">
					Track your cases, open a new one, ask the AI assistant, or report
					abuse.
				</p>
			</header>

			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<SupportCard
					icon={LifeBuoy}
					title="My cases"
					description="View and reply to your open and resolved support cases."
					href={`${base}/my-cases`}
				/>
				<SupportCard
					icon={PlusCircle}
					title="Submit a case"
					description="Open a new case for a technical, billing, or account issue."
					href={`${base}/submit`}
				/>
				<SupportCard
					icon={Sparkles}
					title="Ask AI"
					description="Get instant answers about your projects, clusters, and billing."
					href={`${base}/ask`}
				/>
				<SupportCard
					icon={ShieldAlert}
					title="Report abuse"
					description="Flag phishing, malware, spam, or other policy violations."
					href={`${base}/abuse`}
				/>
				<SupportCard
					icon={MessagesSquare}
					title="Ask community"
					description={
						COMMUNITY_URL
							? "Search discussions and ask other Alethia users."
							: "Community discussions — coming soon."
					}
					href={COMMUNITY_URL}
					external={Boolean(COMMUNITY_URL)}
					disabled={!COMMUNITY_URL}
				/>
			</div>
		</div>
	);
}
