"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Transaction history (Billing page) — the org's recent Stripe charges (paid /
// failed / refunded), with a color-free status badge. Read-only.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	listTransactions,
	type TransactionInfo,
} from "@/app/server/actions/billing";
import { Skeleton } from "@/components/ui/skeleton";
import styles from "./billing-design.module.css";

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

const STATUS_LABEL: Record<TransactionInfo["status"], string> = {
	paid: "Paid",
	pending: "Pending",
	failed: "Failed",
	refunded: "Refunded",
};

export function TransactionsTable() {
	const [rows, setRows] = useState<TransactionInfo[] | null>(null);

	useEffect(() => {
		listTransactions()
			.then(setRows)
			.catch(() => toast.error("Couldn't load transactions."));
	}, []);

	return (
		<section className={styles.section}>
			<div className={styles.sectionHead}>
				<h2>Transaction history</h2>
				<span className={styles.rule} />
			</div>
			<div className={`${styles.card} ${styles.tblWrap}`}>
				{!rows ? (
					<div style={{ padding: 18 }}>
						<Skeleton className="h-24 w-full" />
					</div>
				) : rows.length === 0 ? (
					<div className={styles.empty}>No transactions yet.</div>
				) : (
					<>
						<div className={styles.scrollX}>
							<table className={styles.table}>
								<thead>
									<tr>
										<th>Date</th>
										<th>Description</th>
										<th>Method</th>
										<th>Status</th>
										<th className={styles.right}>Amount</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((t) => (
										<tr key={t.id}>
											<td className={styles.date}>{formatDate(t.created)}</td>
											<td>
												<div className={styles.desc}>{t.description}</div>
											</td>
											<td className={styles.method}>{t.method ?? "—"}</td>
											<td>
												<span className={`${styles.status} ${styles[t.status]}`}>
													<span className={styles.s} />
													{STATUS_LABEL[t.status]}
												</span>
											</td>
											<td className={`${styles.right} ${styles.amt}`}>
												{formatAmount(t.amount, t.currency)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<div className={styles.tblFoot}>
							<span className={styles.count}>
								{rows.length} transaction{rows.length === 1 ? "" : "s"}
							</span>
						</div>
					</>
				)}
			</div>
		</section>
	);
}
