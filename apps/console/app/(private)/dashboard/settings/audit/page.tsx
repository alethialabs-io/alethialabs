"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AuditLog } from "@/components/settings/audit/audit-log";
import { ExportAuditButton } from "@/components/settings/audit/export-audit-button";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function AuditPage() {
	return (
		<>
			<SettingsHeader
				title="Audit Log"
				description="Denied access attempts and sensitive actions in your organization."
				action={<ExportAuditButton />}
			/>
			<AuditLog />
		</>
	);
}
