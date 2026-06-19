"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function GeneralPage() {
	return (
		<>
			<SettingsHeader
				title="General"
				description="Your organization's name, slug, and danger zone."
			/>
			<EnterpriseGate
				entitlement="organizations"
				title="Organization settings"
				description="Create an organization to manage its name, members, and settings. Available on Enterprise."
			>
				{/* Org name/slug + danger zone land in UI-6. */}
				<div />
			</EnterpriseGate>
		</>
	);
}
