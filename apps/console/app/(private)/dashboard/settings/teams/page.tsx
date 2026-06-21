"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SettingsGate } from "@/components/settings/settings-gate";
import { SettingsPageHead } from "@/components/settings/settings-ui";
import { TeamsList } from "@/components/settings/teams/teams-list";

export default function TeamsPage() {
	return (
		<div>
			<SettingsPageHead
				eyebrow="Teams"
				title="Teams"
				description="Group members into teams and grant access to Zones by team rather than one person at a time. A grant on a team flows to every member."
			/>
			<SettingsGate entitlement="organizations" feature="Teams">
				<TeamsList />
			</SettingsGate>
		</div>
	);
}
