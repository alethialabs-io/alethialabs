"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The confirmation in front of the one irreversible staff act: performing an erasure.
//
// It is the console's `ConfirmAction` at `severity: destroy`, in this app's terms: the consequences
// are listed, the destructive button stays disabled until the case reference is typed exactly, and
// while the erasure runs neither Cancel nor Escape closes the dialog. The console component cannot
// be imported from a sibling app (apps/admin/eslint.config.mjs), and it lives in apps/console rather
// than @repo/ui, so this is the admin app's copy of its typed half. The server action re-checks the
// typed reference, so the dialog is not the only thing between a POST and an erasure.

import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { useState } from "react";

/** What the erasure does and does not do, stated before it runs. */
const CONSEQUENCES = [
	"Every row the erasure register lists for this account is deleted or pseudonymized, in one transaction.",
	"Records kept under a legal obligation (orders, invoices, accepted terms, the authorization log) are retained and named in the scope.",
	"A tombstone is left so a later restore re-applies the erasure.",
	"If the subject's organizations still run infrastructure, nothing is erased and the case stays open.",
	"This cannot be undone.",
];

/**
 * A typed confirmation for `fulfilErasure`. `onConfirm` receives the typed reference and resolves
 * true to close the dialog; false (a refused or failed erasure) keeps it open beside the error.
 */
export function ConfirmErasureDialog({
	reference,
	open,
	onOpenChange,
	onConfirm,
}: {
	reference: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (typed: string) => Promise<boolean>;
}) {
	const [typed, setTyped] = useState("");
	const [pending, setPending] = useState(false);
	const matches = typed.trim() === reference;

	/** Runs the erasure once; closes on success. */
	async function confirm() {
		if (!matches || pending) return;
		setPending(true);
		const done = await onConfirm(typed.trim());
		setPending(false);
		if (done) {
			setTyped("");
			onOpenChange(false);
		}
	}

	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!next && pending) return;
				if (!next) setTyped("");
				onOpenChange(next);
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Perform the erasure for {reference}?</AlertDialogTitle>
					<AlertDialogDescription>
						Identity has been verified on this request. The erasure runs now.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
					{CONSEQUENCES.map((c) => (
						<li key={c}>{c}</li>
					))}
				</ul>
				<form
					className="grid gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						void confirm();
					}}
				>
					<div className="space-y-1">
						<Label htmlFor="erasure-confirm">
							<span>
								Type <span className="font-mono font-medium">{reference}</span> to confirm
							</span>
						</Label>
						<Input
							id="erasure-confirm"
							autoComplete="off"
							spellCheck={false}
							value={typed}
							disabled={pending}
							onChange={(e) => setTyped(e.target.value)}
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
						<Button
							type="submit"
							variant="destructive"
							disabled={!matches || pending}
							aria-busy={pending}
						>
							{pending ? "Erasing…" : "Perform erasure"}
						</Button>
					</AlertDialogFooter>
				</form>
			</AlertDialogContent>
		</AlertDialog>
	);
}
