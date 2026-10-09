// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AccessManager } from "@/components/settings/access/access-manager";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Access · Settings",
	description: "Access grants and resource-level permissions for your organization.",
});

/** `/{org}/~/settings/access` — the org's access grants. The `customRoles` entitlement is resolved
 * here, on the server, so the first paint is the list (or the upsell) rather than an upsell shown
 * while the client store loads (#5850). */
export default async function AccessPage() {
	const { customRoles } = getEntitlements(await currentActor());
	return <AccessManager customRoles={customRoles} />;
}
