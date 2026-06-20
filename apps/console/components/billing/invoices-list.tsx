"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invoice history for the billing panel — date, number, amount, status, and a PDF link.
// Read-only; the PDFs are Stripe-hosted.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type InvoiceInfo, listInvoices } from "@/app/server/actions/billing";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/** Smallest-unit amount → localized currency string. */
function formatAmount(total: number, currency: string): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
	}).format(total / 100);
}

export function InvoicesList() {
	const [invoices, setInvoices] = useState<InvoiceInfo[] | null>(null);

	useEffect(() => {
		listInvoices()
			.then(setInvoices)
			.catch(() => toast.error("Couldn't load invoices."));
	}, []);

	return (
		<div className="space-y-3">
			<h3 className="text-sm font-semibold text-foreground">Invoices</h3>
			{!invoices ? (
				<Skeleton className="h-24 w-full" />
			) : invoices.length === 0 ? (
				<Card className="p-4 text-sm text-muted-foreground">No invoices yet.</Card>
			) : (
				<Card className="overflow-hidden p-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Date</TableHead>
								<TableHead>Invoice</TableHead>
								<TableHead>Amount</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">PDF</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{invoices.map((inv) => (
								<TableRow key={inv.id}>
									<TableCell>
										{new Date(inv.created).toLocaleDateString()}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{inv.number ?? "—"}
									</TableCell>
									<TableCell>{formatAmount(inv.total, inv.currency)}</TableCell>
									<TableCell>
										<Badge variant="outline" className="text-[10px] capitalize">
											{inv.status}
										</Badge>
									</TableCell>
									<TableCell className="text-right">
										{inv.invoicePdf ? (
											<a
												href={inv.invoicePdf}
												target="_blank"
												rel="noopener noreferrer"
												className="text-sm underline underline-offset-2 hover:text-foreground"
											>
												Download
											</a>
										) : (
											<span className="text-sm text-muted-foreground">—</span>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Card>
			)}
		</div>
	);
}
