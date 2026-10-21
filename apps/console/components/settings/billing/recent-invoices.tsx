"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Recent invoices — the compact invoice list on the main Billing panel. Shows the five most
// recent mirrored invoices (reusing the shared InvoicesTable + preview dialog) under an
// Invoices section whose action links to the full invoices page.
//
// The read is `billing.invoices` with `RECENT_INVOICES_INPUT`, over GET, prefetched by the route
// (#6127). A failed read is an error with a retry: it used to be set to `[]` and rendered as
// "No invoices yet", a statement about the account made on the strength of a failed request.

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal, refusalOf, retryUnlessRefused } from "@/components/settings/billing/read-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { orpc } from "@/lib/rpc/client";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";
import { InvoicePreviewDialog } from "./invoice-preview-dialog";
import { RECENT_INVOICES_INPUT } from "./invoices-filters";
import { InvoicesTable } from "./invoices-table";

/** The Invoices section of the Billing page: the newest five, and a link to all of them. */
export function RecentInvoices() {
	const { org } = useParams<{ org: string }>();
	const rows = useQuery(
		orpc.billing.invoices.queryOptions({ input: RECENT_INVOICES_INPUT, retry: retryUnlessRefused }),
	);
	const refusal = rows.isError ? refusalOf(rows.error) : null;

	// The preview dialog (open state + selected invoice).
	const [selected, setSelected] = useState<InvoiceInfo | null>(null);
	const [previewOpen, setPreviewOpen] = useState(false);

	/** Open the preview dialog for a row. */
	function openPreview(row: InvoiceInfo) {
		setSelected(row);
		setPreviewOpen(true);
	}

	const viewAll = (
		<Link
			href={`/${org}/~/settings/billing/invoices`}
			className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
		>
			View all invoices →
		</Link>
	);

	return (
		<SettingsSection
			title="Invoices"
			action={rows.data && rows.data.length > 0 ? viewAll : undefined}
		>
			{rows.data !== undefined ? (
				<InvoicesTable
					rows={rows.data}
					onPreview={openPreview}
					pageSize={5}
					emptyMessage="No invoices yet — they appear here after your first payment."
				/>
			) : refusal ? (
				<RegionRefusal refusal={refusal} />
			) : rows.isError ? (
				<RegionError
					title="Couldn't load invoices"
					description="Something went wrong reading this organization's invoices."
					onRetry={() => void rows.refetch()}
				/>
			) : (
				<DataTableSkeleton columns={6} rows={3} />
			)}

			<InvoicePreviewDialog
				invoice={selected}
				open={previewOpen}
				onOpenChange={setPreviewOpen}
			/>
		</SettingsSection>
	);
}
