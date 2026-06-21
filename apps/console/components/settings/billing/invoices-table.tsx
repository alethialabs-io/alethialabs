"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invoices table (Billing page) — the org's Stripe invoices with status and a PDF
// receipt link. Read-only; the PDFs are Stripe-hosted.

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type InvoiceInfo, listInvoices } from "@/app/server/actions/billing";
import { Skeleton } from "@/components/ui/skeleton";
import styles from "./billing-design.module.css";

type Badge = "paid" | "pending" | "failed";

/** Maps a Stripe invoice status to the color-free badge variant + label. */
function invoiceStatus(status: string): { variant: Badge; label: string } {
	switch (status) {
		case "paid":
			return { variant: "paid", label: "Paid" };
		case "open":
		case "draft":
			return { variant: "pending", label: "Processing" };
		case "void":
		case "uncollectible":
			return { variant: "failed", label: "Failed" };
		default:
			return { variant: "pending", label: status };
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
		<section className={styles.section} style={{ marginBottom: 0 }}>
			<div className={styles.sectionHead}>
				<h2>Invoices</h2>
				<span className={styles.rule} />
			</div>
			<div className={`${styles.card} ${styles.tblWrap}`}>
				{!rows ? (
					<div style={{ padding: 18 }}>
						<Skeleton className="h-24 w-full" />
					</div>
				) : rows.length === 0 ? (
					<div className={styles.empty}>No invoices yet.</div>
				) : (
					<>
						<div className={styles.scrollX}>
							<table className={styles.table}>
								<thead>
									<tr>
										<th>Invoice</th>
										<th>Issued</th>
										<th>Billing period</th>
										<th>Status</th>
										<th className={styles.right}>Total</th>
										<th className={styles.right}>Receipt</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((inv) => {
										const st = invoiceStatus(inv.status);
										return (
											<tr key={inv.id}>
												<td className={styles.inv}>{inv.number ?? "—"}</td>
												<td className={styles.date}>{formatDate(inv.created)}</td>
												<td className={styles.period}>
													{formatPeriod(inv.created)}
												</td>
												<td>
													<span
														className={`${styles.status} ${styles[st.variant]}`}
													>
														<span className={styles.s} />
														{st.label}
													</span>
												</td>
												<td className={`${styles.right} ${styles.amt}`}>
													{formatAmount(inv.total, inv.currency)}
												</td>
												<td className={styles.right}>
													{inv.invoicePdf ? (
														<a
															className={styles.dl}
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
						</div>
						<div className={styles.tblFoot}>
							<span className={styles.count}>
								{rows.length} invoice{rows.length === 1 ? "" : "s"}
							</span>
						</div>
					</>
				)}
			</div>
		</section>
	);
}
