"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RolesManager } from "@/components/settings/roles/roles-manager";

/** Roles — built-in roles (read-only) + custom roles (Enterprise), IAM-style master-detail. */
export default function RolesPage() {
	return <RolesManager />;
}
