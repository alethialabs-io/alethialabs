"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { MembersTable } from "@/components/settings/members/members-table";

export default function MembersPage() {
	return (
		<EnterpriseGate
			entitlement="organizations"
			title="Members"
			description="Invite teammates and manage their roles in this organization."
		>
			<MembersTable />
		</EnterpriseGate>
	);
}
