"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { TeamsList } from "@/components/settings/teams/teams-list";

export default function TeamsPage() {
	return (
		<EnterpriseGate
			entitlement="organizations"
			title="Teams"
			description="Create teams and manage their members, then grant access to a team in one step. Available on Enterprise."
		>
			<TeamsList />
		</EnterpriseGate>
	);
}
