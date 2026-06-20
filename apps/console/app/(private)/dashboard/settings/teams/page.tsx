"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { SettingsHeader } from "@/components/settings/settings-header";
import { TeamsList } from "@/components/settings/teams/teams-list";

export default function TeamsPage() {
	return (
		<>
			<SettingsHeader
				title="Teams"
				description="Group members so you can grant access to a whole team at once."
			/>
			<EnterpriseGate
				entitlement="organizations"
				title="Teams"
				description="Create teams and manage their members, then grant access to a team in one step. Available on Enterprise."
			>
				<TeamsList />
			</EnterpriseGate>
		</>
	);
}
