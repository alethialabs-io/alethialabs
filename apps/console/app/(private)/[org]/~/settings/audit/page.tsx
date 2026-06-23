"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AuditLog } from "@/components/settings/audit/audit-log";

/** Audit Log — the PDP's recorded access decisions (community-real; export is Enterprise). */
export default function AuditPage() {
	return <AuditLog />;
}
