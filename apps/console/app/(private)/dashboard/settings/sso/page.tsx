"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { SettingsHeader } from "@/components/settings/settings-header";
import { SsoProviders } from "@/components/settings/sso/sso-providers";

export default function SsoPage() {
	return (
		<>
			<SettingsHeader
				title="Single Sign-On"
				description="Let your team sign in through your identity provider (OIDC or SAML)."
			/>
			<EnterpriseGate
				entitlement="sso"
				title="Single Sign-On"
				description="Connect your IdP (Okta, Entra ID, AWS IAM Identity Center, Google Workspace, …) over OIDC or SAML. Available on Enterprise."
			>
				<SsoProviders />
			</EnterpriseGate>
		</>
	);
}
