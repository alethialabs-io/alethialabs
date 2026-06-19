"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function MembersPage() {
	return (
		<>
			<SettingsHeader
				title="Members"
				description="Invite people to your organization and assign their roles."
			/>
			<EnterpriseGate
				entitlement="organizations"
				title="Member management"
				description="Organizations with multiple members are an Enterprise feature. Your personal workspace has a single owner — you."
			>
				{/* Member table + invite dialog land in UI-3. */}
				<div />
			</EnterpriseGate>
		</>
	);
}
