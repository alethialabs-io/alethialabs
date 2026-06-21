"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Transaction history (Billing page) — the org's recent Stripe charges (paid /
// failed / refunded), composed from the shared settings primitives. Read-only.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	listTransactions,
	type TransactionInfo,
} from "@/app/server/actions/billing";
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

/** Smallest-unit amount → localized currency (negative renders as −$x). */
function formatAmount(amount: number, currency: string): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
		signDisplay: "auto",
	}).format(amount / 100);
}

/** "1 Jun 2026" */
function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

const STATUS: Record<TransactionInfo["status"], { variant: string; label: string }> = {
	paid: { variant: "vx-status--active", label: "Paid" },
	pending: { variant: "vx-status--pending", label: "Pending" },
	failed: { variant: "vx-status--failed", label: "Failed" },
	refunded: { variant: "vx-status--idle", label: "Refunded" },
};

export function TransactionsTable() {
	const [rows, setRows] = useState<TransactionInfo[] | null>(null);

	useEffect(() => {
		listTransactions()
			.then(setRows)
			.catch(() => toast.error("Couldn't load transactions."));
	}, []);

	return (
		<SettingsSection title="Transaction history">
			{!rows ? (
				<div className="rounded-lg border border-border bg-surface p-[18px] shadow-sm">
					<Skeleton className="h-24 w-full" />
				</div>
			) : rows.length === 0 ? (
				<div className="rounded-lg border border-border bg-surface px-[18px] py-[18px] text-[13px] text-text-tertiary shadow-sm">
					No transactions yet.
				</div>
			) : (
				<SettingsTableCard
					foot={
						<SettingsTableFoot>
							<span>
								{rows.length} transaction{rows.length === 1 ? "" : "s"}
							</span>
						</SettingsTableFoot>
					}
				>
					<table className={settingsTableRows}>
						<thead>
							<tr>
								<th className={settingsTh}>Date</th>
								<th className={settingsTh}>Description</th>
								<th className={settingsTh}>Method</th>
								<th className={settingsTh}>Status</th>
								<th className={cn(settingsTh, "text-right")}>Amount</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((t) => {
								const st = STATUS[t.status];
								return (
									<tr key={t.id}>
										<td
											className={cn(
												settingsTd,
												"whitespace-nowrap font-mono text-[11.5px] text-text-secondary",
											)}
										>
											{formatDate(t.created)}
										</td>
										<td className={settingsTd}>
											<span className="text-text-primary">{t.description}</span>
										</td>
										<td
											className={cn(settingsTd, "font-mono text-[11.5px] text-text-tertiary")}
										>
											{t.method ?? "—"}
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
											{formatAmount(t.amount, t.currency)}
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
