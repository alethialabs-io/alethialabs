// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SupportAskChat } from "@/components/support/ask/support-ask-chat";
import { SHELL_VIEWPORT } from "@/components/shell/shell-metrics";
import { getOwner } from "@/lib/auth/owner";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Ask AI",
	description:
		"Get instant answers about your Alethia projects, clusters, runners, and billing — or open a support case.",
});

/**
 * The Ask-AI support page — a full-height conversation with the elench support
 * assistant. Reuses the shared agent chat stack (`SupportAskChat` → `/api/support/ask`)
 * and passes the org slug so an approved case links to `/{org}/~/support/cases/{id}`, and the
 * signed-in user's id, which keys the conversation the tab keeps across "View case" (G-10).
 */
export default async function SupportAskPage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const viewerId = await getOwner();
	return (
		<div className={`flex ${SHELL_VIEWPORT} -m-4 flex-col sm:-m-6 lg:-m-8 xl:-m-10`}>
			<SupportAskChat orgSlug={org} viewerId={viewerId} />
		</div>
	);
}
