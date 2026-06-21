"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invoices table (Billing page) — the org's Stripe invoices with status and a PDF
// receipt link, composed from the shared settings primitives. Read-only; the PDFs
// are Stripe-hosted.

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type InvoiceInfo, listInvoices } from "@/app/server/actions/billing";
import {
	SettingsSection,
	SettingsTableCard,
	SettingsTableFoot,
	settingsTableRows,
	settingsTd,
	settingsTh,
} from "@/components/settings/settings-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Maps a Stripe invoice status to the color-free badge variant + label. */
function invoiceStatus(status: string): { variant: string; label: string } {
	switch (status) {
		case "paid":
			return { variant: "vx-status--active", label: "Paid" };
		case "open":
		case "draft":
			return { variant: "vx-status--pending", label: "Processing" };
		case "void":
		case "uncollectible":
			return { variant: "vx-status--failed", label: "Failed" };
		default:
			return { variant: "vx-status--pending", label: status };
	}
}

/** Smallest-unit amount → localized currency. */
function formatAmount(total: number, currency: string): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
	}).format(total / 100);
}

/** "1 Jun 2026" */
function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** "Jun 2026" — the billing period label (issue month). */
function formatPeriod(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		year: "numeric",
	});
}

export function InvoicesTable() {
	const [rows, setRows] = useState<InvoiceInfo[] | null>(null);

	useEffect(() => {
		listInvoices()
			.then(setRows)
			.catch(() => toast.error("Couldn't load invoices."));
	}, []);

	return (
		<SettingsSection title="Invoices" className="mb-0">
			{!rows ? (
				<div className="rounded-lg border border-border bg-surface p-[18px] shadow-sm">
					<Skeleton className="h-24 w-full" />
				</div>
			) : rows.length === 0 ? (
				<div className="rounded-lg border border-border bg-surface px-[18px] py-[18px] text-[13px] text-text-tertiary shadow-sm">
					No invoices yet.
				</div>
			) : (
				<SettingsTableCard
					foot={
						<SettingsTableFoot>
							<span>
								{rows.length} invoice{rows.length === 1 ? "" : "s"}
							</span>
						</SettingsTableFoot>
					}
				>
					<table className={settingsTableRows}>
						<thead>
							<tr>
								<th className={settingsTh}>Invoice</th>
								<th className={settingsTh}>Issued</th>
								<th className={settingsTh}>Billing period</th>
								<th className={settingsTh}>Status</th>
								<th className={cn(settingsTh, "text-right")}>Total</th>
								<th className={cn(settingsTh, "text-right")}>Receipt</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((inv) => {
								const st = invoiceStatus(inv.status);
								return (
									<tr key={inv.id}>
										<td className={cn(settingsTd, "font-mono text-[11.5px] text-text-primary")}>
											{inv.number ?? "—"}
										</td>
										<td
											className={cn(
												settingsTd,
												"whitespace-nowrap font-mono text-[11.5px] text-text-secondary",
											)}
										>
											{formatDate(inv.created)}
										</td>
										<td
											className={cn(settingsTd, "font-mono text-[11.5px] text-text-secondary")}
										>
											{formatPeriod(inv.created)}
										</td>
										<td className={settingsTd}>
											<span className={cn("vx-status", st.variant)}>
												<span className="vx-status__dot" />
												{st.label}
											</span>
										</td>
										<td
											className={cn(
												settingsTd,
												"text-right font-mono text-[12.5px] text-text-primary",
											)}
										>
											{formatAmount(inv.total, inv.currency)}
										</td>
										<td className={cn(settingsTd, "text-right")}>
											{inv.invoicePdf ? (
												<a
													className="inline-flex items-center gap-1.5 rounded-sm border border-border px-[9px] py-[5px] font-mono text-[11px] text-text-tertiary transition-colors hover:border-border-strong hover:bg-surface-muted hover:text-text-primary"
													href={inv.invoicePdf}
													target="_blank"
													rel="noopener noreferrer"
												>
													<Download size={12} />
													PDF
												</a>
											) : (
												"—"
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</SettingsTableCard>
			)}
		</SettingsSection>
	);
}
