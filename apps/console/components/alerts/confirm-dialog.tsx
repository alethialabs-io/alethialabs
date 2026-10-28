"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A small reusable destructive-confirmation dialog (replaces window.confirm for alert
// deletions). Mirrors the AlertDialog pattern in components/runners/pool-card.tsx.
//
// The dialog STAYS OPEN while the confirmed action runs (#6125). Its primary button is a plain
// button, not the primitive's Close, so clicking it does not dismiss the dialog: it shows
// `pendingLabel` and is disabled (the double-submit guard), Cancel and Escape do nothing until the
// action settles, and the caller closes the dialog once it succeeds. A delete that fails therefore
// leaves the question on screen with the toast beside it, instead of a dialog that vanished on click
// while nothing had happened yet.

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

interface ConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	confirmLabel?: string;
	/** The primary button's text while the action runs. */
	pendingLabel?: string;
	/** True while the confirmed action is in flight: the dialog cannot be dismissed or re-confirmed. */
	pending?: boolean;
	/** Runs the action. The caller closes the dialog (via `onOpenChange`) when it is done. */
	onConfirm: () => void;
}

/** A yes/no confirm with a destructive primary action and a pending state. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = "Delete",
	pendingLabel = "Working…",
	pending = false,
	onConfirm,
}: ConfirmDialogProps) {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!next && pending) return;
				onOpenChange(next);
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
					<Button variant="destructive" disabled={pending} aria-busy={pending} onClick={onConfirm}>
						{pending ? pendingLabel : confirmLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
