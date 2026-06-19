"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEntitlement } from "@/components/settings/enterprise-gate";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import { MembersTable } from "@/components/settings/members/members-table";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function MembersPage() {
	const canManage = useEntitlement("organizations");

	return (
		<>
			<SettingsHeader
				title="Members"
				description="People in this organization and their roles."
				action={canManage ? <InviteMemberDialog /> : undefined}
			/>
			<MembersTable />
		</>
	);
}
