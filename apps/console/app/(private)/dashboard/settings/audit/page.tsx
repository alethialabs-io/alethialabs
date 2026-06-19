"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function AuditPage() {
	return (
		<>
			<SettingsHeader
				title="Audit Log"
				description="Every authorization decision in your organization, with export."
			/>
			<EnterpriseGate
				entitlement="auditExport"
				title="Audit log export"
				description="Browse and export the full authorization decision log. Available on Enterprise."
			>
				{/* Audit table + export land in UI-5. */}
				<div />
			</EnterpriseGate>
		</>
	);
}
