// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AccessManager } from "@/components/settings/access/access-manager";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Access · Settings",
	description: "Access grants and resource-level permissions for your organization.",
});

export default function AccessPage() {
	return <AccessManager />;
}
