"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createEnterpriseOrg } from "@/app/orgs/actions";
import {
	ContractFields,
	type ContractState,
	emptyContract,
	toContractPayload,
} from "./contract-fields";

/** Flow B — create a new Enterprise org, invite the owner, and set the plan. */
export function CreateOrgForm() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [ownerEmail, setOwnerEmail] = useState("");
	const [state, setState] = useState<ContractState>(emptyContract);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<{ orgId: string; invoiceUrl: string | null } | null>(
		null,
	);

	const input =
		"w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

	async function submit() {
		setBusy(true);
		setError(null);
		let res: Awaited<ReturnType<typeof createEnterpriseOrg>>;
		try {
			res = await createEnterpriseOrg({
				name,
				slug,
				ownerEmail,
				...toContractPayload(state),
			});
		} catch (err) {
			// Deployment skew: a newer build shipped while this page was open, so the action
			// reference no longer resolves ("Server Action … was not found on the server"). The
			// action never ran — a hard reload fetches the current bundle so the retry is clean.
			const msg = err instanceof Error ? err.message : String(err);
			if (/server action|was not found on the server/i.test(msg)) {
				setError("The app was updated — reloading…");
				window.location.reload();
				return;
			}
			setBusy(false);
			setError(msg || "Failed");
			return;
		}
		setBusy(false);
		if (!res.ok || !res.orgId) {
			setError(res.error ?? "Failed");
			return;
		}
		setDone({ orgId: res.orgId, invoiceUrl: res.invoiceUrl ?? null });
	}

	if (done) {
		return (
			<div className="space-y-3 rounded-lg border p-4">
				<h2 className="text-sm font-medium text-green-600 dark:text-green-500">
					Org created
				</h2>
				<p className="text-sm text-muted-foreground">
					The owner ({ownerEmail}) has been emailed an invitation to join as owner. They get
					access once they accept (and sign in with that exact email).
				</p>
				{done.invoiceUrl && (
					<p className="text-sm">
						Stripe invoice:{" "}
						<a href={done.invoiceUrl} target="_blank" rel="noreferrer" className="underline">
							{done.invoiceUrl}
						</a>
					</p>
				)}
				<button
					type="button"
					onClick={() => router.push(`/orgs/${done.orgId}`)}
					className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
				>
					Open org
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-3 rounded-lg border p-4">
			<div className="grid grid-cols-2 gap-3">
				<label className="block space-y-1">
					<span className="text-xs text-muted-foreground">Org name</span>
					<input className={input} value={name} onChange={(e) => setName(e.target.value)} />
				</label>
				<label className="block space-y-1">
					<span className="text-xs text-muted-foreground">Slug</span>
					<input
						className={input}
						value={slug}
						onChange={(e) => setSlug(e.target.value.toLowerCase())}
						placeholder="acme"
					/>
				</label>
			</div>
			<label className="block space-y-1">
				<span className="text-xs text-muted-foreground">Owner email</span>
				<input
					className={input}
					value={ownerEmail}
					onChange={(e) => setOwnerEmail(e.target.value)}
					placeholder="cto@acme.com"
				/>
			</label>
			<ContractFields value={state} onChange={setState} />
			{error && <p className="text-sm text-destructive">{error}</p>}
			<button
				type="button"
				disabled={busy || !state.reason.trim() || !name || !slug || !ownerEmail}
				onClick={() => void submit()}
				className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
			>
				{busy ? "Creating…" : "Create Enterprise org"}
			</button>
		</div>
	);
}
