"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { useState } from "react";
import { grantEnterprise } from "@/app/orgs/actions";
import {
	ContractFields,
	type ContractState,
	emptyContract,
	toContractPayload,
} from "./contract-fields";

/** Flow A — flip an existing org to Enterprise. Owner email seeds the Stripe customer. */
export function GrantEnterpriseForm({
	orgId,
	ownerEmail,
}: {
	orgId: string;
	ownerEmail: string;
}) {
	const router = useRouter();
	const [state, setState] = useState<ContractState>({
		...emptyContract,
		reason: "",
	});
	const [email, setEmail] = useState(ownerEmail);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [invoiceUrl, setInvoiceUrl] = useState<string | null>(null);

	async function submit() {
		setBusy(true);
		setError(null);
		setInvoiceUrl(null);
		const res = await grantEnterprise({
			orgId,
			ownerEmail: email,
			...toContractPayload(state),
		});
		setBusy(false);
		if (!res.ok) {
			setError(res.error ?? "Failed");
			return;
		}
		setInvoiceUrl(res.invoiceUrl ?? null);
		router.refresh();
	}

	return (
		<div className="space-y-3 rounded-lg border p-4">
			<h2 className="text-sm font-medium">Grant Enterprise</h2>
			<label className="block space-y-1">
				<span className="text-xs text-muted-foreground">Owner email (Stripe customer)</span>
				<input
					className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
			</label>
			<ContractFields value={state} onChange={setState} />
			{error && <p className="text-sm text-destructive">{error}</p>}
			{invoiceUrl && (
				<p className="text-sm text-green-600 dark:text-green-500">
					Done. Invoice:{" "}
					<a href={invoiceUrl} target="_blank" rel="noreferrer" className="underline">
						{invoiceUrl}
					</a>
				</p>
			)}
			<button
				type="button"
				disabled={busy || !state.reason.trim()}
				onClick={() => void submit()}
				className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
			>
				{busy ? "Applying…" : "Grant Enterprise"}
			</button>
		</div>
	);
}
