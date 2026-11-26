"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { linkPaddleCustomerAction } from "@/app/orgs/actions";
import {
	type LinkPaddleCustomerFormValues,
	linkPaddleCustomerFormSchema,
} from "@/lib/platform/paddle-customer-link";

const inputClass =
	"w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

/**
 * "Link Paddle customer" — stores the org's Paddle customer id, for a customer invoiced by hand from
 * the Paddle dashboard. Shows the stored value; replacing a different one takes a second, explicit
 * confirmation naming the value being replaced.
 */
export function LinkPaddleCustomerForm({
	orgId,
	current,
}: {
	orgId: string;
	current: string | null;
}) {
	const router = useRouter();
	const form = useForm<LinkPaddleCustomerFormValues>({
		resolver: zodResolver(linkPaddleCustomerFormSchema),
		defaultValues: { customerId: "", reason: "" },
	});
	const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	/** Sends the link; `replace` is the stored id the operator confirmed replacing, or null. */
	async function send(values: LinkPaddleCustomerFormValues, replace: string | null) {
		setError(null);
		setDone(null);
		const res = await linkPaddleCustomerAction({ orgId, ...values, replace });
		if (res.confirmReplace) {
			setConfirmReplace(res.confirmReplace);
			return;
		}
		setConfirmReplace(null);
		if (!res.ok) {
			setError(res.error ?? "Failed");
			return;
		}
		if (!res.changed) {
			setDone("Already linked to that customer; nothing changed.");
		} else {
			setDone(
				res.verified
					? "Linked. Paddle confirmed the customer exists."
					: "Linked. Paddle is not configured on the console, so the customer was not checked.",
			);
			form.reset();
		}
		router.refresh();
	}

	const busy = form.formState.isSubmitting;
	const { errors } = form.formState;

	return (
		<form
			className="space-y-3 rounded-lg border p-4"
			onSubmit={form.handleSubmit((values) => send(values, null))}
		>
			<h2 className="text-sm font-medium">Link Paddle customer</h2>
			<p className="text-xs text-muted-foreground">
				For a customer invoiced by hand from the Paddle dashboard: stores their Paddle customer id on
				this organization so its Paddle transactions are recorded against it.
			</p>
			<dl className="text-sm">
				<div className="flex justify-between gap-3">
					<dt className="text-muted-foreground">Current</dt>
					<dd className="truncate font-mono text-xs">{current ?? "— (none)"}</dd>
				</div>
			</dl>
			<label className="block space-y-1">
				<span className="text-xs text-muted-foreground">Paddle customer id</span>
				<input
					className={`${inputClass} font-mono`}
					placeholder="ctm_…"
					autoComplete="off"
					{...form.register("customerId", { onChange: () => setConfirmReplace(null) })}
				/>
				{errors.customerId && <span className="block text-xs text-destructive">{errors.customerId.message}</span>}
			</label>
			<label className="block space-y-1">
				<span className="text-xs text-muted-foreground">Reason (recorded in the audit log)</span>
				<input className={inputClass} {...form.register("reason")} />
				{errors.reason && <span className="block text-xs text-destructive">{errors.reason.message}</span>}
			</label>
			{confirmReplace && (
				<div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
					<p>
						This organization is linked to <span className="font-mono text-xs">{confirmReplace}</span>.
						Replace it with <span className="font-mono text-xs">{form.getValues("customerId").trim()}</span>?
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							disabled={busy}
							onClick={() => void form.handleSubmit((values) => send(values, confirmReplace))()}
							className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
						>
							Replace
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => setConfirmReplace(null)}
							className="rounded-md border px-3 py-1.5 text-sm"
						>
							Cancel
						</button>
					</div>
				</div>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{done && <p className="text-sm text-foreground">{done}</p>}
			{!confirmReplace && (
				<button
					type="submit"
					disabled={busy}
					className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
				>
					{busy ? "Linking…" : "Link Paddle customer"}
				</button>
			)}
		</form>
	);
}
