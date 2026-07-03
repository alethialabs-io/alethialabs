// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { TeamsList } from "@/components/settings/teams/teams-list";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Teams · Settings",
	description: "Teams and their members within your organization.",
});

export default function TeamsPage() {
	return <TeamsList />;
}
