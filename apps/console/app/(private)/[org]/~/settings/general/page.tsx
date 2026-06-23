"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { OrgGeneral } from "@/components/settings/general/org-general";
import { SettingsGate } from "@/components/settings/settings-gate";
import { SettingsPageHead } from "@/components/settings/settings-ui";

export default function GeneralPage() {
	return (
		<div>
			<SettingsPageHead
				eyebrow="General"
				title="General"
				description="Your organization's identity and defaults — name, slug, and provisioning defaults."
			/>
			<SettingsGate entitlement="organizations" feature="Organization settings">
				<OrgGeneral />
			</SettingsGate>
		</div>
	);
}
