// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MembersTable } from "@/components/settings/members/members-table";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Members · Settings",
	description: "Organization members and pending invitations.",
});

export default function MembersPage() {
	return <MembersTable />;
}
