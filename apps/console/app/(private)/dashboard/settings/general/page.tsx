"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { OrgGeneral } from "@/components/settings/general/org-general";

export default function GeneralPage() {
	return (
		<EnterpriseGate
			entitlement="organizations"
			title="Organization settings"
			description="Create an organization to manage its name, members, and settings."
		>
			<OrgGeneral />
		</EnterpriseGate>
	);
}
