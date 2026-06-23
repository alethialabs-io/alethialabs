"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SettingsGate } from "@/components/settings/settings-gate";
import { SettingsPageHead } from "@/components/settings/settings-ui";
import { SsoManager } from "@/components/settings/sso/sso-manager";

export default function SsoPage() {
	return (
		<div>
			<SettingsPageHead
				eyebrow="Single Sign-On"
				title="Single Sign-On"
				description="Connect your identity provider over OIDC or SAML and route members signing in with a matching email domain to it. Sign-in is brokered by your IdP — Alethia never stores passwords."
			/>
			<SettingsGate entitlement="sso" feature="Single Sign-On">
				<SsoManager />
			</SettingsGate>
		</div>
	);
}
