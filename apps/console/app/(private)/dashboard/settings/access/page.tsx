"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AccessManager } from "@/components/settings/access/access-manager";
import { SettingsGate } from "@/components/settings/settings-gate";
import { SettingsPageHead } from "@/components/settings/settings-ui";

export default function AccessPage() {
	return (
		<div>
			<SettingsPageHead
				eyebrow="Access"
				title="Access"
				description="Grants bind a member or team to a role on a scope. Grant at the highest level that fits and inheritance flows it down — a Zone grant reaches every Spec inside."
			/>
			<SettingsGate entitlement="customRoles" feature="Access management">
				<AccessManager />
			</SettingsGate>
		</div>
	);
}
