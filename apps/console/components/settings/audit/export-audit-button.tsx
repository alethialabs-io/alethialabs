"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getAuditExportCsv } from "@/app/server/actions/audit";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { Button } from "@/components/ui/button";

/** CSV export of the audit log — only rendered when the auditExport entitlement is held. */
export function ExportAuditButton() {
	const canExport = useEntitlement("auditExport");
	const [busy, setBusy] = useState(false);
	if (!canExport) return null;

	const onExport = async () => {
		setBusy(true);
		try {
			const csv = await getAuditExportCsv();
			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "audit-log.csv";
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Export failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Button size="sm" variant="outline" className="gap-2" onClick={onExport} disabled={busy}>
			<Download className="h-4 w-4" />
			Export CSV
		</Button>
	);
}
