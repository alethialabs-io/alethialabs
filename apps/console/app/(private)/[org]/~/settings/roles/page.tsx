// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RolesManager } from "@/components/settings/roles/roles-manager";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Roles · Settings",
	description: "Built-in and custom roles for fine-grained access control.",
});

/** Roles — built-in roles (read-only) + custom roles (Enterprise), IAM-style master-detail. */
export default function RolesPage() {
	return <RolesManager />;
}
