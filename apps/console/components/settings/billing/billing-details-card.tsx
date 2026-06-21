"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing details card (Billing page) — the authored design display of the org's billing
// contact / address / VAT id, with an Edit dialog that reuses the <BillingDetails> form.
// The address + VAT id feed Stripe Tax and appear on invoices.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type BillingDetails as BillingDetailsData,
	getBillingDetails,
} from "@/app/server/actions/billing";
import { BillingDetails as BillingDetailsForm } from "@/components/billing/billing-details";
import { SettingsSection } from "@/components/settings/settings-ui";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

/** Joins the address parts onto two lines for display (empty parts dropped). */
function addressLines(d: BillingDetailsData): string[] {
	const l1 = d.line1;
	const l2 = [d.postalCode, d.city, d.state, d.country].filter(Boolean).join(" ");
	return [l1, d.line2, l2].filter(Boolean);
}

/** One label/value display row. */
function DRow({
	label,
	value,
	mono,
}: {
	label: string;
	value: React.ReactNode;
	mono?: boolean;
}) {
	return (
		<div className="flex items-start justify-between gap-4 px-[18px] py-[11px]">
			<span className="shrink-0 text-[12.5px] text-text-tertiary">{label}</span>
			<span
				className={
					mono
						? "text-right font-mono text-[11.5px] text-text-primary"
						: "text-right text-[12.5px] leading-normal text-text-primary"
				}
			>
				{value}
			</span>
		</div>
	);
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
		<SettingsSection
			title="Billing details"
			className="mb-0"
			action={
				<button
					type="button"
					className="text-[12.5px] text-text-tertiary transition-colors hover:text-text-primary"
					onClick={() => setEditOpen(true)}
				>
					Edit
				</button>
			}
		>
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				{!loaded ? (
					<div className="p-[18px]">
						<Skeleton className="h-32 w-full" />
					</div>
				) : (
					<div className="flex flex-col py-1.5">
						<DRow label="Billing email" value={details?.email || "—"} mono />
						<DRow label="Company" value={details?.name || "—"} />
						<DRow label="VAT ID" value={details?.taxId || "—"} mono />
						<DRow
							label="Address"
							value={
								lines.length ? (
									lines.map((line, i) => (
										<span key={`${i}:${line}`} className="block">
											{line}
										</span>
									))
								) : (
									<>—</>
								)
							}
						/>
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
		</SettingsSection>
	);
}
