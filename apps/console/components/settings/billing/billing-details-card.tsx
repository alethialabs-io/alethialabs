"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing details card (Billing page) — re-skinned display of the org's billing
// contact / address / VAT id, with an Edit dialog that reuses the <BillingDetails>
// form. The address + VAT id feed Stripe Tax and appear on invoices.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type BillingDetails as BillingDetailsData,
	getBillingDetails,
} from "@/app/server/actions/billing";
import { BillingDetails as BillingDetailsForm } from "@/components/billing/billing-details";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import styles from "./billing-design.module.css";

/** Joins the address parts onto two lines for display (empty parts dropped). */
function addressLines(d: BillingDetailsData): string[] {
	const l1 = d.line1;
	const l2 = [d.postalCode, d.city, d.state, d.country].filter(Boolean).join(" ");
	return [l1, d.line2, l2].filter(Boolean);
}

export function BillingDetailsCard() {
	const [details, setDetails] = useState<BillingDetailsData | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [editOpen, setEditOpen] = useState(false);

	function load() {
		getBillingDetails()
			.then(setDetails)
			.catch(() => toast.error("Couldn't load billing details."))
			.finally(() => setLoaded(true));
	}
	useEffect(load, []);

	function onSaved() {
		setEditOpen(false);
		load();
	}

	const lines = details ? addressLines(details) : [];

	return (
		<section className={styles.section} style={{ marginBottom: 0 }}>
			<div className={styles.sectionHead}>
				<h2>Billing details</h2>
				<span className={styles.rule} />
				<button
					type="button"
					className={styles.act}
					onClick={() => setEditOpen(true)}
				>
					Edit
				</button>
			</div>
			<div className={styles.card}>
				{!loaded ? (
					<div style={{ padding: 18 }}>
						<Skeleton className="h-32 w-full" />
					</div>
				) : (
					<div className={styles.detailRows}>
						<div className={styles.drow}>
							<span className={styles.k}>Billing email</span>
							<span className={`${styles.v} ${styles.mono}`}>
								{details?.email || "—"}
							</span>
						</div>
						<div className={styles.drow}>
							<span className={styles.k}>Company</span>
							<span className={styles.v}>{details?.name || "—"}</span>
						</div>
						<div className={styles.drow}>
							<span className={styles.k}>VAT ID</span>
							<span className={`${styles.v} ${styles.mono}`}>
								{details?.taxId || "—"}
							</span>
						</div>
						<div className={styles.drow}>
							<span className={styles.k}>Address</span>
							<span className={styles.v}>
								{lines.length ? (
									lines.map((line, i) => (
										<span key={`${i}:${line}`} style={{ display: "block" }}>
											{line}
										</span>
									))
								) : (
									<>—</>
								)}
							</span>
						</div>
					</div>
				)}
			</div>

			<Dialog open={editOpen} onOpenChange={setEditOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Edit billing details</DialogTitle>
					</DialogHeader>
					<BillingDetailsForm onSaved={onSaved} />
				</DialogContent>
			</Dialog>
		</section>
	);
}
