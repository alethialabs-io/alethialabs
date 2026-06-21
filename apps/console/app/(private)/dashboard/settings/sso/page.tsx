"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SsoManager } from "@/components/settings/sso/sso-manager";

/** Single Sign-On — connect an OIDC/SAML IdP for the organization. Enterprise. */
export default function SsoPage() {
	return <SsoManager />;
}
