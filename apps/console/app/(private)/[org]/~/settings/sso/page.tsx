// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SsoManager } from "@/components/settings/sso/sso-manager";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "SSO · Settings",
	description: "Single sign-on and SCIM provisioning for your organization.",
});

export default function SsoPage() {
	return <SsoManager />;
}
