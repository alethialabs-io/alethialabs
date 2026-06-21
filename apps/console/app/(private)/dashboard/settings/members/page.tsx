"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MembersTable } from "@/components/settings/members/members-table";
import { SettingsGate } from "@/components/settings/settings-gate";
import { SettingsPageHead } from "@/components/settings/settings-ui";

export default function MembersPage() {
	return (
		<div>
			<SettingsPageHead
				eyebrow="Members"
				title="Members"
				description="People with access to this organization. Each member holds a built-in role; fine-grained grants are managed under Access."
			/>
			<SettingsGate entitlement="organizations" feature="Member management">
				<MembersTable />
			</SettingsGate>
		</div>
	);
}
